import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb } from '../config/database.js';
import { createSecretBox } from '../utils/secretBox.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../utils/totp.js';
import { TranslatableError } from '../i18n/index.js';
import TenantUser from '../models/TenantUser.js';
import { mfaRequired } from '../models/Tenant.js';
import { PRODUCT_NAME } from '../config/brand.js';

/**
 * Login em duas etapas: o segredo do app autenticador e os códigos de
 * recuperação de cada PESSOA.
 *
 * `users` e `user_recovery_codes` são tabelas compartilhadas — a linha é a
 * pessoa, que entra em vários provedores e no console com o mesmo login —, e
 * por isso tudo aqui fala com `getDb()` direto, sem escopo de provedor.
 */

export const MFA_SECRET_CONTEXT = 'skygenpanel-user-totp-v1';
export const RECOVERY_CODE_COUNT = 10;
export const MFA_ISSUER = PRODUCT_NAME;

let box = null;
const caixa = () => {
  box ??= createSecretBox(MFA_SECRET_CONTEXT);
  return box;
};

function selar(secret) {
  const cifrado = caixa().encrypt(secret);
  return {
    totp_ciphertext: cifrado.password_ciphertext,
    totp_iv: cifrado.password_iv,
    totp_tag: cifrado.password_tag,
    totp_key_version: cifrado.password_key_version
  };
}

function abrir(user) {
  return caixa().decrypt({
    password_ciphertext: user?.totp_ciphertext,
    password_iv: user?.totp_iv,
    password_tag: user?.totp_tag,
    password_key_version: user?.totp_key_version
  });
}

const SEM_SEGREDO = Object.freeze({
  totp_ciphertext: null,
  totp_iv: null,
  totp_tag: null,
  totp_key_version: null,
  totp_enabled_at: null,
  totp_last_step: null
});

/** Se esta pessoa tem o login em duas etapas ligado. */
export function mfaEnabled(user) {
  return Boolean(user?.totp_enabled_at);
}

/**
 * Um código de recuperação, como a pessoa o digita: sem traços, sem espaços,
 * sem diferença de maiúsculas. É a forma que vira hash — digitar "ABCDE-12345"
 * ou "abcde12345" tem que dar no mesmo.
 */
export function normalizeRecoveryCode(code) {
  return String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

/** Dez códigos de 10 caracteres base32 (50 bits cada), no formato "xxxxx-xxxxx". */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const alfabeto = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from({ length: count }, () => {
    const bytes = crypto.randomBytes(10);
    const texto = Array.from(bytes, (byte) => alfabeto[byte & 31]).join('');
    return `${texto.slice(0, 5)}-${texto.slice(5)}`;
  });
}

const recusa = (key, code, status = 400) => new TranslatableError(key, null, { status, code });

class MfaService {
  static async findUser(userId) {
    return (await getDb()('users').where({ id: userId }).first()) || null;
  }

  /** O que a tela da conta precisa saber — nunca o segredo. */
  static async status(userId) {
    const user = await this.findUser(userId);
    if (!user) return { enabled: false, recoveryRemaining: 0 };
    const [{ n }] = await getDb()('user_recovery_codes')
      .where({ user_id: userId })
      .whereNull('used_at')
      .count({ n: '*' });
    return { enabled: mfaEnabled(user), recoveryRemaining: mfaEnabled(user) ? Number(n) : 0 };
  }

  /**
   * Começa a ativação: um segredo novo, guardado cifrado e AINDA SEM VALER.
   *
   * Só vale depois que a pessoa digita um código gerado por ele (`enable`) —
   * é a prova de que o app leu o QR. Começar de novo troca o segredo pendente.
   * Com o 2FA já ligado, recusa: trocar o segredo de quem já usa exige
   * desativar antes, com senha e código.
   */
  static async setup(userId) {
    const user = await this.findUser(userId);
    if (!user) throw recusa('auth.userNotFound', 'user_not_found', 404);
    if (mfaEnabled(user)) throw recusa('auth.mfaAlreadyEnabled', 'mfa_already_enabled', 409);
    const secret = generateTotpSecret();
    await getDb()('users').where({ id: userId }).update({
      ...SEM_SEGREDO,
      ...selar(secret),
      updated_at: new Date()
    });
    const label = user.email || user.username;
    return { secret, uri: totpUri({ secret, label, issuer: MFA_ISSUER }) };
  }

  /**
   * Liga o 2FA com o primeiro código certo, e devolve os códigos de
   * recuperação — a única vez em que eles existem em texto.
   *
   * Sobe o `token_version`, como `disable`, `regenerateRecoveryCodes` e
   * `resetForUser`: mudar o segundo fator é mudar credencial, e toda sessão
   * aberta antes disso cai. Quem ativa costuma fazê-lo justamente por
   * desconfiar da senha — uma sessão que outra pessoa abriu com ela não pode
   * sobreviver ao 2FA que veio fechá-la. A aba de quem pediu não cai: a rota
   * devolve tokens novos (ver `AuthController.mfaEnable`).
   */
  static async enable(userId, code) {
    const user = await this.findUser(userId);
    if (!user) throw recusa('auth.userNotFound', 'user_not_found', 404);
    if (mfaEnabled(user)) throw recusa('auth.mfaAlreadyEnabled', 'mfa_already_enabled', 409);
    const secret = abrir(user);
    if (!secret) throw recusa('auth.mfaNotStarted', 'mfa_not_started');
    const passo = verifyTotp(secret, code);
    if (passo === null) throw recusa('auth.mfaInvalid', 'mfa_invalid');

    const codes = generateRecoveryCodes();
    await getDb().transaction(async (trx) => {
      await trx('users').where({ id: userId }).update({
        totp_enabled_at: new Date(),
        totp_last_step: passo,
        token_version: trx.raw('token_version + 1'),
        updated_at: new Date()
      });
      await trx('user_recovery_codes').where({ user_id: userId }).del();
      await trx('user_recovery_codes').insert(codes.map((c) => ({ user_id: userId, code_hash: hashRecoveryCode(c) })));
    });
    return { recoveryCodes: codes };
  }

  /**
   * O segundo fator de quem já passou pela senha: um código do app ou um de
   * recuperação.
   *
   * O código do app só vale num passo POSTERIOR ao último aceito, e a gravação
   * do passo é condicional — duas entradas simultâneas com o mesmo código não
   * passam as duas. O de recuperação é gasto na mesma instrução que o confere.
   *
   * `consume: false` confere sem gastar. É o que o login usa logo depois da
   * senha: a resposta seguinte pode ser "em qual provedor?", e a tela reenvia o
   * mesmo código com a escolha — gasto na primeira ida, ele seria recusado
   * como repetição na segunda. O código é gasto onde a sessão nasce.
   *
   * @returns {Promise<{ ok: boolean, via: 'totp'|'recovery'|null }>}
   */
  static async verifySecondFactor(user, code, { consume = true } = {}) {
    if (!mfaEnabled(user)) return { ok: false, via: null };
    const digitado = String(code ?? '').trim();
    if (!digitado || digitado.length > 64) return { ok: false, via: null };

    if (/^\d{6}$/.test(digitado.replace(/\s/g, ''))) {
      const secret = abrir(user);
      if (!secret) return { ok: false, via: null };
      const ultimo = user.totp_last_step === null || user.totp_last_step === undefined
        ? null
        : Number(user.totp_last_step);
      const passo = verifyTotp(secret, digitado, { afterStep: ultimo });
      if (passo === null) return { ok: false, via: null };
      if (!consume) return { ok: true, via: 'totp' };
      const gravou = await getDb()('users')
        .where({ id: user.id })
        .where((q) => q.whereNull('totp_last_step').orWhere('totp_last_step', '<', passo))
        .update({ totp_last_step: passo });
      return gravou > 0 ? { ok: true, via: 'totp' } : { ok: false, via: null };
    }

    if (normalizeRecoveryCode(digitado).length !== 10) return { ok: false, via: null };
    if (!consume) {
      const existe = await getDb()('user_recovery_codes')
        .where({ user_id: user.id, code_hash: hashRecoveryCode(digitado) })
        .whereNull('used_at')
        .first('id');
      return existe ? { ok: true, via: 'recovery' } : { ok: false, via: null };
    }
    const gastou = await getDb()('user_recovery_codes')
      .where({ user_id: user.id, code_hash: hashRecoveryCode(digitado) })
      .whereNull('used_at')
      .update({ used_at: new Date() });
    return gastou > 0 ? { ok: true, via: 'recovery' } : { ok: false, via: null };
  }

  /** Senha e segundo fator, as duas coisas que desligar ou trocar os códigos exige. */
  static async confirmIdentity(user, password, code) {
    const senhaOk = typeof password === 'string' && password.length > 0 && password.length <= 128
      && await bcrypt.compare(password, user.password);
    if (!senhaOk) throw recusa('auth.currentPasswordIncorrect', 'invalid_password', 401);
    const { ok } = await this.verifySecondFactor(user, code);
    if (!ok) throw recusa('auth.mfaInvalid', 'mfa_invalid');
  }

  /**
   * Desligar o próprio 2FA é recusado enquanto algum provedor da pessoa o
   * exigir. Deixar desligar só a levaria, na requisição seguinte, à tela de
   * ativar de novo — e no meio do caminho ela teria uma sessão sem segundo fator
   * num provedor que o proibiu.
   *
   * Sobe o `token_version`: ver `enable`.
   */
  static async disable(userId, password, code) {
    const user = await this.findUser(userId);
    if (!user) throw recusa('auth.userNotFound', 'user_not_found', 404);
    if (!mfaEnabled(user)) throw recusa('auth.mfaNotEnabled', 'mfa_not_enabled', 409);
    const vinculos = await TenantUser.listForUserWithTenant(userId);
    if (vinculos.some((vinculo) => mfaRequired(vinculo))) {
      throw recusa('auth.mfaRequiredByProvider', 'mfa_required_by_provider', 409);
    }
    await this.confirmIdentity(user, password, code);
    await getDb().transaction(async (trx) => {
      await trx('users').where({ id: userId }).update({
        ...SEM_SEGREDO,
        token_version: trx.raw('token_version + 1'),
        updated_at: new Date()
      });
      await trx('user_recovery_codes').where({ user_id: userId }).del();
    });
  }

  /**
   * Desliga o 2FA de alguém que perdeu o celular E os códigos — por quem
   * administra a equipe, ou pelo comando do servidor.
   *
   * Sobe o `token_version` junto: as sessões abertas caem. Quem pede isso
   * acredita que o segundo fator saiu do controle da pessoa, e a mesma dúvida
   * vale para uma sessão que alguém esteja usando no lugar dela.
   *
   * @returns {Promise<boolean>} se havia 2FA para desligar
   */
  static async resetForUser(userId) {
    const db = getDb();
    const user = await this.findUser(userId);
    if (!user) return false;
    const tinha = mfaEnabled(user) || Boolean(user.totp_ciphertext);
    await db.transaction(async (trx) => {
      await trx('users').where({ id: userId }).update({
        ...SEM_SEGREDO,
        token_version: db.raw('token_version + 1'),
        updated_at: new Date()
      });
      await trx('user_recovery_codes').where({ user_id: userId }).del();
    });
    return tinha;
  }

  /**
   * Códigos novos; os antigos, usados ou não, deixam de valer.
   *
   * Sobe o `token_version` também: quem troca os códigos acha que os antigos
   * vazaram, e quem os tinha pode já ter entrado com um deles. Ver `enable`.
   */
  static async regenerateRecoveryCodes(userId, password, code) {
    const user = await this.findUser(userId);
    if (!user) throw recusa('auth.userNotFound', 'user_not_found', 404);
    if (!mfaEnabled(user)) throw recusa('auth.mfaNotEnabled', 'mfa_not_enabled', 409);
    await this.confirmIdentity(user, password, code);
    const codes = generateRecoveryCodes();
    await getDb().transaction(async (trx) => {
      await trx('users').where({ id: userId }).update({
        token_version: trx.raw('token_version + 1'),
        updated_at: new Date()
      });
      await trx('user_recovery_codes').where({ user_id: userId }).del();
      await trx('user_recovery_codes').insert(codes.map((c) => ({ user_id: userId, code_hash: hashRecoveryCode(c) })));
    });
    return { recoveryCodes: codes };
  }
}

export default MfaService;

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb } from '../config/database.js';
import { createErrorResponse } from '../utils/helpers.js';
import { runInTenant } from '../config/tenantContext.js';
import { LOCKOUT_STALE_DAYS } from '../config/retention.js';
import AuditLog from './AuditLog.js';
import TenantUser from './TenantUser.js';

/**
 * A trava por CONTA contra força bruta na senha e no segundo fator.
 *
 * O limitador do login (`authLimiter`) conta por (provedor do host, endereço):
 * ele segura quem martela de UM lugar, e não segura nada de quem distribui os
 * palpites — cada endereço novo é um balde novo, e cada subdomínio de provedor
 * também. O que um ataque desses tem em comum é o ALVO, e é por ele que esta
 * tabela conta.
 *
 * A política, num lugar só:
 *
 * - **10 tentativas numa janela de 15 minutos** (contada da primeira), e a
 *   décima errada TRAVA a conta por **15 minutos**. Janela e não "consecutivas
 *   para sempre": quem erra a senha uma vez por mês não pode acumular até ser
 *   trancado num dia qualquer.
 * - **Toda tentativa conta ANTES da conferência** (`attempt`), e não só a que
 *   deu errado. É o que torna o teto exato contra rajada: com a contagem depois
 *   do bcrypt, cem requisições simultâneas leriam "9 erros" ao mesmo tempo e as
 *   cem ganhariam um palpite. Contando antes, o incremento é atômico no banco e
 *   a 11ª de uma rajada já vê 11. O preço é que a tentativa que respondeu
 *   `mfa_required` também gasta uma unidade — uma pessoa de verdade gasta duas
 *   por login (senha, depois senha + código) e zera tudo ao entrar.
 * - **Só zera quando a prova termina**: sessão emitida, senha trocada, convite
 *   aceito. Acertar a senha e errar o código NÃO zera — senão o 2FA de quem
 *   teve a senha vazada ficava com palpites infinitos, um por senha certa.
 * - **Travada, a resposta é a mesma com a senha certa ou errada**: 429 com
 *   `code: 'account_locked'`. A conferência nem é feita contra o hash de
 *   verdade — quem chama gasta o bcrypt num hash de enfeite, para o tempo não
 *   contar nada.
 * - Trocar a senha por qualquer caminho (`User.updatePassword`: a própria
 *   pessoa, o link por e-mail, o administrador) apaga a trava. É a porta de
 *   saída de quem foi trancado por um ataque, e quem a abre já provou outra
 *   coisa — a caixa de entrada, ou o cargo de quem administra.
 *
 * O preço que toda trava por conta tem, e que fica escrito: quem sabe o login
 * de alguém consegue trancá-lo por 15 minutos com 10 palpites. Por isso a trava
 * é curta e não cresce — backoff exponencial transformaria isso num jeito
 * barato de tirar uma pessoa do painel por dias. O limitador por endereço
 * continua na frente e é ele que torna esse abuso caro.
 *
 * **O sujeito** é `user:<id>` para quem existe e `login:<sha256>` do
 * identificador digitado para quem não existe. O segundo existe para que a
 * trava não vire oráculo de enumeração: um login inventado também trava na
 * décima tentativa, com a mesma resposta e as mesmas consultas. Guardar o hash e
 * não o texto é para esta tabela não virar uma lista de tudo que alguém tentou
 * como nome — inclusive senhas coladas no campo errado.
 *
 * Tabela no banco e não memória do processo: com duas réplicas atrás do
 * balanceador, contador em memória é um contador por réplica, e o teto vira
 * dez vezes o número de réplicas.
 */
const TABLE = 'account_lockouts';

export const LOCKOUT_MAX_ATTEMPTS = 10;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/** Linha parada há mais que isto, e sem trava valendo, é lixo. */
const STALE_MS = LOCKOUT_STALE_DAYS * 24 * 60 * 60 * 1000;
/** De quanto em quanto tempo, no máximo, um processo faz a poda. */
const PRUNE_EVERY_MS = 10 * 60 * 1000;
let ultimaPoda = 0;

/**
 * O hash de enfeite contra o qual a recusa gasta o bcrypt. Mesmo custo (12) que
 * o das senhas de verdade, para o tempo da recusa ser o de uma conferência.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('skygenpanel-account-locked-placeholder', 12);

/** `bigInteger` volta como string no Postgres; nulo continua nulo. */
const ms = (valor) => (valor === null || valor === undefined ? null : Number(valor));

class AccountLockout {
  static forUser(userId) {
    return `user:${Number(userId)}`;
  }

  /**
   * O sujeito de um login que não casa conta nenhuma. Em minúsculas porque o
   * e-mail é guardado assim, e um atacante não pode ganhar dez palpites novos
   * trocando a caixa de uma letra.
   */
  static forIdentifier(identifier) {
    const hash = crypto.createHash('sha256')
      .update(String(identifier ?? '').trim().toLowerCase())
      .digest('hex');
    return `login:${hash}`;
  }

  /**
   * Registra a tentativa e diz se ela pode seguir.
   *
   * Devolve `{ allowed, subject, attempts, lockedUntil, justLocked }`. Com
   * `allowed: false`, quem chama responde `lockedResponse` e não confere a
   * senha de verdade. `justLocked` é verdadeiro para UMA requisição só — a
   * que fechou a trava —, e é ela quem escreve na trilha.
   */
  static async attempt(subject, now = Date.now()) {
    const db = getDb();
    await AccountLockout.pruneMaybe(now);

    const atual = await db(TABLE).where({ subject }).first();
    if (atual && ms(atual.locked_until) > now) {
      return { allowed: false, subject, attempts: Number(atual.attempts), lockedUntil: ms(atual.locked_until), justLocked: false };
    }

    if (!atual) {
      // `ignore` e não um erro: duas requisições que chegam juntas para o mesmo
      // alvo tentam criar a mesma linha, e a segunda só precisa que ela exista.
      await db(TABLE)
        .insert({ subject, attempts: 0, window_started_at: now, locked_until: null, updated_at: now })
        .onConflict('subject')
        .ignore();
    } else if (ms(atual.locked_until) !== null || ms(atual.window_started_at) + LOCKOUT_WINDOW_MS <= now) {
      // Janela vencida, ou trava que já passou: recomeça do zero. Condicionado
      // ao início de janela que foi LIDO, para que duas requisições que veem a
      // janela velha ao mesmo tempo não zerem uma a contagem da outra depois.
      await db(TABLE)
        .where({ subject, window_started_at: atual.window_started_at })
        .update({ attempts: 0, window_started_at: now, locked_until: null, updated_at: now });
    }

    await db(TABLE).where({ subject }).update({
      attempts: db.raw('attempts + 1'),
      updated_at: now
    });
    const depois = await db(TABLE).where({ subject }).first();
    const attempts = Number(depois?.attempts ?? 1);

    // Passou do teto sem trava gravada: é a rajada que chegou junto com a
    // décima, ou uma sequência de tentativas que não foram erro de senha (o
    // `mfa_required`, por exemplo). Trava aqui, e esta tentativa não segue.
    if (attempts > LOCKOUT_MAX_ATTEMPTS) {
      const travou = await AccountLockout.lock(subject, now);
      return { allowed: false, subject, attempts, lockedUntil: travou.lockedUntil, justLocked: travou.justLocked };
    }
    return { allowed: true, subject, attempts, lockedUntil: null, justLocked: false };
  }

  /**
   * A tentativa deu errado — senha, código, ou login que não existe. A contagem
   * já foi feita em `attempt`; aqui só se decide se esta foi a que fecha a
   * trava, para que a décima errada tranque na hora e a próxima já encontre a
   * porta fechada.
   */
  static async failure(tentativa, now = Date.now()) {
    if (!tentativa || tentativa.attempts < LOCKOUT_MAX_ATTEMPTS) {
      return { locked: false, justLocked: false };
    }
    const travou = await AccountLockout.lock(tentativa.subject, now);
    return { locked: true, ...travou };
  }

  /**
   * `failure` mais a trilha: o caminho que todo controlador usa depois de uma
   * senha ou de um código errado. `user` é nulo para o login inventado, e aí
   * não há onde escrever — mas a trava é gravada do mesmo jeito.
   */
  static async failed(req, tentativa, { user = null, via } = {}) {
    const resultado = await AccountLockout.failure(tentativa);
    if (resultado.justLocked) await AccountLockout.recordLock(req, user, via, resultado.lockedUntil);
    return resultado;
  }

  /**
   * A resposta inteira de quem está travado, pronta para o `return`.
   *
   * O bcrypt é gasto contra o hash de enfeite, e nunca contra o de verdade: a
   * resposta de quem está travado não pode depender da senha — senão a trava
   * viraria um oráculo que confere palpites sem contá-los — e o tempo dela tem
   * que ser o de uma conferência, para não separar "travada" de "senha errada"
   * nem conta que existe de login inventado.
   */
  static async refuse(req, res, tentativa, senha, { user = null, via } = {}) {
    await bcrypt.compare(String(senha ?? '').slice(0, 128), DUMMY_PASSWORD_HASH);
    await AccountLockout.refused(req, tentativa, { user, via });
    return AccountLockout.lockedResponse(req, res, tentativa);
  }

  /**
   * A tentativa voltou recusada por `attempt`. Se foi ela quem fechou a trava
   * (a rajada que passou do teto), escreve a trilha; senão, nada.
   */
  static async refused(req, tentativa, { user = null, via } = {}) {
    if (tentativa?.justLocked) await AccountLockout.recordLock(req, user, via, tentativa.lockedUntil);
  }

  /**
   * Uma linha na trilha de CADA provedor em que a pessoa trabalha.
   *
   * Em todos, e não num só, porque o login não tem provedor ainda — o
   * atacante pode estar batendo no endereço de qualquer um deles, ou no
   * console — e porque o dono de cada provedor tem o mesmo interesse em saber
   * que alguém está tentando a conta de alguém da equipe dele. Autor
   * `system`: ninguém travou a conta, a regra travou. `detail` diz por onde e
   * até quando; nunca o que foi digitado. Como toda escrita da trilha, não
   * lança.
   */
  static async recordLock(req, user, via, lockedUntil) {
    if (!user?.id) return;
    try {
      const vinculos = await TenantUser.listForUser(user.id);
      for (const vinculo of vinculos) {
        // eslint-disable-next-line no-await-in-loop -- um provedor por vez, cada um no seu escopo
        await runInTenant(Number(vinculo.tenant_id), () => AuditLog.record({
          action: AuditLog.ACTIONS.USER_ACCOUNT_LOCKED,
          actorKind: 'system',
          subjectType: 'user',
          subjectId: String(user.id),
          detail: {
            username: user.username ?? null,
            via: via ?? null,
            lockedUntil: lockedUntil ? new Date(lockedUntil).toISOString() : null
          },
          // `req.ip` é getter do Express: lido aqui, e não espalhando `req`.
          ip: req?.ip ?? null
        }));
      }
    } catch (error) {
      console.error('Account lockout audit failed:', error.message);
    }
  }

  /** A prova terminou: some a contagem. */
  static async clear(subject) {
    await getDb()(TABLE).where({ subject }).del();
  }

  static async clearUser(userId) {
    await AccountLockout.clear(AccountLockout.forUser(userId));
  }

  /**
   * Grava a trava. O `whereNull` faz dela uma transição: entre várias
   * requisições que passam do teto juntas, só uma muda a linha, e é essa que
   * volta com `justLocked` — a trilha ganha uma linha por trava, não uma por
   * tentativa recusada.
   */
  static async lock(subject, now) {
    const lockedUntil = now + LOCKOUT_DURATION_MS;
    const mudou = await getDb()(TABLE)
      .where({ subject })
      .whereNull('locked_until')
      .update({ locked_until: lockedUntil, updated_at: now });
    if (mudou > 0) return { lockedUntil, justLocked: true };
    const linha = await getDb()(TABLE).where({ subject }).first();
    return { lockedUntil: ms(linha?.locked_until) ?? lockedUntil, justLocked: false };
  }

  /**
   * Poda o que ninguém vai ler de novo: linhas paradas há um dia, sem trava
   * valendo. Quase todas são de logins inventados, que nunca têm um sucesso
   * para apagá-las. No máximo uma vez a cada dez minutos por processo, e
   * nunca derruba a tentativa: poda que falha fica para a próxima.
   */
  static async pruneMaybe(now) {
    if (now - ultimaPoda < PRUNE_EVERY_MS) return;
    ultimaPoda = now;
    try {
      await getDb()(TABLE)
        .where('updated_at', '<', now - STALE_MS)
        .andWhere((q) => q.whereNull('locked_until').orWhere('locked_until', '<', now))
        .del();
    } catch (error) {
      console.error('Account lockout prune failed:', error.message);
    }
  }

  /**
   * A recusa de quem está travado. Mesma para conta que existe e para login
   * inventado, e nada nela diz se a senha estava certa. `Retry-After` porque o
   * cliente de API precisa saber quando voltar, e o valor não entrega nada que
   * a própria trava não entregue.
   */
  static lockedResponse(req, res, tentativa, now = Date.now()) {
    const segundos = Math.max(1, Math.ceil(((tentativa?.lockedUntil ?? now + LOCKOUT_DURATION_MS) - now) / 1000));
    res.set('Retry-After', String(segundos));
    return res.status(429).json(createErrorResponse(req.t('auth.accountLocked'), null, 'account_locked'));
  }
}

export default AccountLockout;

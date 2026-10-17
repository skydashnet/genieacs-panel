import AuditLog from '../models/AuditLog.js';
import SubscriptionService, { PlanLimitError } from '../services/subscriptionService.js';
import { planLimitResponse } from '../utils/planLimit.js';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import TenantUser from '../models/TenantUser.js';
import PlatformAdmin from '../models/PlatformAdmin.js';
import MfaService from '../services/mfaService.js';
import { createResponse, createErrorResponse, isValidEmail } from '../utils/helpers.js';
import { ROLES, normalizeRole, roleHas } from '../config/permissions.js';

export { ROLES };

/**
 * Os papéis que podem administrar a equipe — hoje `owner` e `admin`.
 *
 * Derivado da matriz e não escrito à mão: o dia em que `tech` puder mexer em
 * operador, a guarda do "último administrador" acompanha sozinha. Escrito à
 * mão, ela contaria de menos e deixaria o provedor sem ninguém no comando.
 */
const ADMINISTRADORES = ROLES.filter((role) => roleHas(role, 'operators.manage'));

const BCRYPT_ROUNDS = 12;

/**
 * This screen is a provider's team, not the deployment's user list.
 *
 * Everything below reads and writes `tenant_users` for the provider the request
 * resolved to. A person (`users`) is global and may work for more than one
 * provider; what this controller may see and change is the MEMBERSHIP here.
 *
 * The scope comes from `req.tenantId`, which `resolveTenant` puts on every
 * `/api` request. When the access token starts carrying `tenantId`, the scope
 * arrives from the token instead and this line is the only thing that moves:
 * nothing below asks how the provider was decided.
 */
function tenantOf(req) {
  return req.tenantId;
}

function normalizeUsername(value) {
  return String(value ?? '').trim();
}

/**
 * O papel tal como vale aqui.
 *
 * Linhas escritas antes de os papéis serem gerenciáveis carregam `'user'`, que
 * era o default da coluna, e as memberships que a 0028 preencheu carregam o que
 * a pessoa tinha em `users.role`. Qualquer coisa desconhecida cai em `viewer` —
 * a direção segura, e a mesma leitura que este arquivo já fazia quando os
 * papéis eram dois; o que mudou é que a regra agora mora em um lugar só, junto
 * da matriz que decide o que cada papel alcança.
 */
const presentRole = normalizeRole;

/**
 * The person, wearing the role they hold HERE.
 *
 * `users.role` is deliberately not read: somebody can own the ISP they founded
 * and be an ordinary operator at the one they consult for, and this endpoint
 * answers for one provider at a time.
 */
function present(member) {
  return {
    id: member.id,
    username: member.username,
    // Mostrado para que a tela consiga responder "quem ainda não cadastrou o
    // e-mail?", que é a pergunta que decide quando dá para exigir e-mail no
    // login sem trancar ninguém do lado de fora.
    email: member.email ?? null,
    role: presentRole(member.role),
    // Só se está ligado: é o que a tela precisa para dizer quem ainda falta
    // quando o dono exige o 2FA, e para oferecer o destravar.
    mfaEnabled: Boolean(member.totp_enabled_at),
    createdAt: member.created_at,
    updatedAt: member.updated_at
  };
}

/**
 * Espelha o papel na coluna antiga quando isso ainda é honesto, e derruba as
 * sessões abertas para que a mudança valha agora.
 *
 * `users.role` não é mais a verdade — a membership é, e a guarda de rota lê a
 * capacidade do papel que o token carrega. A coluna sobrevive como fallback do
 * token antigo, que não traz `tenantId`, e por isso continua valendo a pena
 * mantê-la em dia: deixá-la para trás faria alguém rebaixado aqui continuar
 * alcançando rota de administrador enquanto o token velho não expira. Espelhar
 * só é honesto enquanto a pessoa trabalha para este provedor sozinho: com
 * várias memberships uma coluna não guarda dois papéis, e escrevê-la deixaria
 * este provedor mudar o que aquela pessoa pode fazer em outro. Aí a coluna fica
 * como está e só as sessões caem.
 */
export async function applyRoleSideEffects(userId, role) {
  const memberships = await TenantUser.listForUser(userId);
  if (memberships.length <= 1) {
    await User.updateRole(userId, role);
    return;
  }
  await User.revokeSessions(userId);
}

class UsersController {
  static async list(req, res) {
    try {
      const members = await TenantUser.listForTenant(tenantOf(req));
      return res.json(createResponse(req.t('users.listed'), {
        users: members.map(present)
      }));
    } catch (error) {
      console.error('List users error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('users.listFailed'), error.message)
      );
    }
  }

  static async create(req, res) {
    try {
      const tenantId = tenantOf(req);
      const username = normalizeUsername(req.body?.username);
      const password = String(req.body?.password ?? '');
      const role = presentRole(req.body?.role);
      // Conta nova nasce com e-mail. Contas sem endereço existem só como
      // herança de antes desta versão, e a tela de operadores mostra quais são
      // — é assim que se sabe quando dá para virar `LOGIN_REQUIRES_EMAIL`.
      const email = User.normalizeEmail(req.body?.email);

      // Mesma regra da promoção: quem não é `owner` não cunha um.
      if (role === 'owner' && presentRole(req.user.role) !== 'owner') {
        return res.status(403).json(
          createErrorResponse(req.t('users.ownerOnly'))
        );
      }

      if (username.length < 3 || username.length > 64) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.usernameLength'))
        );
      }
      if (password.length < 8 || password.length > 128) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.passwordLength'))
        );
      }
      if (!email || !isValidEmail(email)) {
        return res.status(400).json(createErrorResponse(req.t('auth.emailInvalid')));
      }
      if (!ROLES.includes(req.body?.role)) {
        return res.status(400).json(
          createErrorResponse(req.t('users.roleInvalid', { roles: ROLES.join(', ') }))
        );
      }

      // A username that is already taken is refused, whether the person works
      // here or for another provider entirely — and with the same words either
      // way, so the answer never says which.
      //
      // The tempting alternative is to attach the existing person to this
      // provider. It is wrong from this endpoint: the request carries a
      // PASSWORD, and there is exactly one password per person, so "create
      // maria" typed by this provider's admin would reset the password of a
      // stranger who works for somebody else, log her out everywhere
      // (`updatePassword` bumps `token_version`), and hand this admin working
      // credentials for another ISP's panel. Joining an existing person to a
      // second provider is a real act that needs that person's consent; it is
      // not the accidental outcome of guessing a username here.
      // Nome e e-mail conferidos juntos, contra o mesmo espaço de nomes: um
      // e-mail igual ao nome de outra pessoa (ou o contrário) tornaria o
      // identificador de login ambíguo, e `findByLogin` recusaria os dois.
      //
      // E UMA resposta só para os dois casos, byte por byte: com "e-mail já
      // usado" distinto de "nome já usado", o administrador de um provedor
      // descobriria, tentativa a tentativa, quais e-mails têm conta em OUTRO
      // painel — o cadastro inteiro da instalação, enumerável daqui. A
      // mensagem aponta o caminho certo (o convite), sem dizer qual dos dois
      // colidiu nem onde. O console da plataforma (`platformMemberController`)
      // segue distinguindo: quem está lá enxerga todos os cadastros mesmo.
      const conflito = await User.loginConflict({ username, email });
      if (conflito) {
        return res.status(409).json(createErrorResponse(req.t('users.loginUnavailable')));
      }

      // O limite do plano, conferido ANTES de escrever qualquer coisa: uma
      // pessoa criada e depois recusada seria um username tomado para sempre.
      try {
        await SubscriptionService.assertCanAddOperator();
      } catch (error) {
        if (error instanceof PlanLimitError) return planLimitResponse(req, res, error);
        throw error;
      }

      const id = await User.create({
        username,
        password: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role,
        email
      });
      try {
        await TenantUser.create({ tenantId, userId: id, role });
      } catch (error) {
        // The person was created only to be given this membership. Without it
        // they belong to nobody and no screen can reach them again, while their
        // username stays taken forever. Undoing is safe precisely here: the row
        // is seconds old and nothing points at it yet.
        await User.remove(id);
        throw error;
      }

      const created = await User.findById(id);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.OPERATOR_CREATED,
        subjectType: 'tenant_user',
        subjectId: id,
        detail: { username, role }
      });
      return res.status(201).json(
        createResponse(req.t('users.created'), {
          user: present({ ...created, role })
        })
      );
    } catch (error) {
      console.error('Create user error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('users.createFailed'), error.message)
      );
    }
  }

  static async update(req, res) {
    try {
      const tenantId = tenantOf(req);
      const id = Number(req.params?.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json(createErrorResponse(req.t('users.invalidId')));
      }

      // Somebody who does not work here answers as nonexistent, never as
      // forbidden: "you may not touch this operator" would confirm to whoever
      // asked that the id belongs to a real person at another provider.
      const membership = await TenantUser.find(tenantId, id);
      const user = membership ? await User.findById(id) : null;
      if (!membership || !user) {
        return res.status(404).json(createErrorResponse(req.t('users.notFound')));
      }

      const nextRole = req.body?.role;
      const nextPassword = req.body?.password;
      if (nextRole === undefined && nextPassword === undefined) {
        return res.status(400).json(
          createErrorResponse(req.t('users.nothingToUpdate'))
        );
      }

      // A senha de um `owner` é dele (ou de outro `owner`) para trocar. Sem
      // isto, um `admin` definia a senha do dono e entrava como ele — tomava a
      // conta pela porta ao lado das que já estão fechadas (papel, vínculo,
      // 2FA). Conferido ANTES de qualquer escrita: um PATCH com papel e senha
      // juntos não pode trocar o papel e só depois recusar a senha.
      if (nextPassword !== undefined
        && presentRole(membership.role) === 'owner'
        && presentRole(req.user.role) !== 'owner') {
        return res.status(403).json(
          createErrorResponse(req.t('users.ownerOnly'))
        );
      }
      // A própria senha se troca pelo perfil, que pede a senha atual. Por
      // aqui bastava o token de acesso: quem roubasse um de uma hora definia
      // uma senha nova e ficava com a conta.
      if (nextPassword !== undefined && id === req.user.userId) {
        return res.status(400).json(
          createErrorResponse(req.t('users.passwordSelf'), null, 'password_self')
        );
      }
      // Quem administra a plataforma entra no console com esta mesma senha.
      // Deixar um provedor defini-la seria entregar a ele o console inteiro —
      // todos os provedores, personificação, cobrança. A mesma regra do
      // `resetMfa`, e também antes de qualquer escrita.
      if (nextPassword !== undefined && await PlatformAdmin.has(id)) {
        return res.status(409).json(
          createErrorResponse(req.t('users.passwordPlatform'), null, 'password_platform')
        );
      }

      if (nextRole !== undefined) {
        if (!ROLES.includes(nextRole)) {
          return res.status(400).json(
            createErrorResponse(req.t('users.roleInvalid', { roles: ROLES.join(', ') }))
          );
        }
        // Só um `owner` mexe no papel de `owner` — para dar e para tirar. Sem
        // isto, um `admin` promoveria a si mesmo ao papel de cima com um PATCH,
        // e a distinção entre os dois não existiria de fato. 403 e não 404: o
        // operador alvo está na mesma equipe de quem pergunta, e a resposta não
        // revela nada que quem trabalha ali já não veja na tela.
        const mexeEmOwner = nextRole === 'owner' || presentRole(membership.role) === 'owner';
        if (mexeEmOwner && presentRole(req.user.role) !== 'owner') {
          return res.status(403).json(
            createErrorResponse(req.t('users.ownerOnly'))
          );
        }
        // Rebaixar-se a si mesmo abaixo de quem administra a equipe é sair pela
        // porta e deixar a chave dentro: a pessoa perde a própria tela de
        // operadores no mesmo request. A condição é a CAPACIDADE e não o nome
        // do papel — um `owner` virando `admin` continua administrando e passa
        // direto, que é o que se quer.
        if (id === req.user.userId && !roleHas(nextRole, 'operators.manage')) {
          return res.status(409).json(
            createErrorResponse(req.t('users.ownAdminRole'))
          );
        }
        // Losing the last administrator would leave THIS provider unmanageable.
        // Counted over the whole deployment, as it was before memberships
        // existed, this guard was wrong in both directions at once: another
        // ISP's administrators kept this one from demoting its last, and this
        // one's last could go while the count stayed positive on somebody
        // else's staff.
        //
        // Inalcançável por esta rota como ela está, e mantido de propósito:
        // `requirePermission('operators.manage')` garante que quem pede já
        // administra AQUI, então um alvo que também administra faz a conta ser
        // dois. É o invariante que importa, não o ramo — o dia em que `tech`
        // puder mexer na equipe, é isto que impede o provedor de ficar trancado
        // por fora, e nada mais impediria.
        if (roleHas(membership.role, 'operators.manage')
          && !roleHas(nextRole, 'operators.manage')
          && await TenantUser.countByRoles(tenantId, ADMINISTRADORES) <= 1) {
          return res.status(409).json(
            createErrorResponse(req.t('users.lastAdmin'))
          );
        }
        await TenantUser.setRole(tenantId, id, nextRole);
        await applyRoleSideEffects(id, nextRole);
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.OPERATOR_ROLE_CHANGED,
          subjectType: 'tenant_user',
          subjectId: id,
          detail: { username: user.username, from: presentRole(membership.role), to: nextRole }
        });
      }

      if (nextPassword !== undefined) {
        const password = String(nextPassword);
        if (password.length < 8 || password.length > 128) {
          return res.status(400).json(
            createErrorResponse(req.t('auth.passwordLength'))
          );
        }
        // A person has one password, for every provider they work for. Setting
        // it here for somebody who also works elsewhere would be this provider
        // handing itself a login at another one, so that is refused rather than
        // done quietly; the person changes their own password from their
        // profile, which reaches all of their providers at once and is theirs
        // to do.
        if ((await TenantUser.listForUser(id)).length > 1) {
          return res.status(409).json(
            createErrorResponse(req.t('users.passwordElsewhere'))
          );
        }
        // updatePassword also revokes the operator's existing sessions.
        await User.updatePassword(id, await bcrypt.hash(password, BCRYPT_ROUNDS));
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.OPERATOR_PASSWORD_SET,
          subjectType: 'tenant_user',
          subjectId: id,
          detail: { username: user.username }
        });
      }

      const updated = await User.findById(id);
      const current = await TenantUser.find(tenantId, id);
      return res.json(createResponse(req.t('users.updated'), {
        user: present({ ...updated, role: current?.role })
      }));
    } catch (error) {
      console.error('Update user error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('users.updateFailed'), error.message)
      );
    }
  }

  /**
   * Ends the membership. The person stays.
   *
   * They may work for another provider, and their name is on history that
   * points at `users.id` — who sent that message, who revoked that opt-out, who
   * created that campaign. Deleting the row would blank all of it (the foreign
   * keys are ON DELETE SET NULL) at another provider as well as here.
   */
  static async remove(req, res) {
    try {
      const tenantId = tenantOf(req);
      const id = Number(req.params?.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json(createErrorResponse(req.t('users.invalidId')));
      }
      if (id === req.user.userId) {
        return res.status(409).json(
          createErrorResponse(req.t('users.deleteSelf'))
        );
      }
      const membership = await TenantUser.find(tenantId, id);
      if (!membership) {
        return res.status(404).json(createErrorResponse(req.t('users.notFound')));
      }
      // A mesma regra do PATCH, e ela precisa estar nos dois: encerrar o
      // vínculo de um `owner` é estritamente pior que rebaixá-lo, e proteger só
      // a promoção deixaria um `admin` conseguindo pela porta ao lado
      // exatamente o que a outra recusa — tirar o dono do provedor de cena.
      if (presentRole(membership.role) === 'owner' && presentRole(req.user.role) !== 'owner') {
        return res.status(403).json(
          createErrorResponse(req.t('users.ownerOnly'))
        );
      }
      // Same invariant as the demotion above, and unreachable for the same
      // reason: the caller is an administrator here, so removing a different
      // one leaves at least themselves.
      if (roleHas(membership.role, 'operators.manage')
        && await TenantUser.countByRoles(tenantId, ADMINISTRADORES) <= 1) {
        return res.status(409).json(
          createErrorResponse(req.t('users.lastAdmin'))
        );
      }

      await TenantUser.remove(tenantId, id);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.OPERATOR_REMOVED,
        subjectType: 'tenant_user',
        subjectId: id,
        detail: { role: presentRole(membership.role) }
      });
      // Their open sessions were sessions here. Revocation lives on the person,
      // so this signs them out of their other providers too — the blunt end of
      // one `token_version` per person, and the safe direction of the two.
      await User.revokeSessions(id);
      return res.json(createResponse(req.t('users.deleted'), { id }));
    } catch (error) {
      console.error('Delete user error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('users.deleteFailed'), error.message)
      );
    }
  }

  /**
   * Desliga o 2FA de alguém da equipe que perdeu o celular e os códigos.
   *
   * As regras são as da troca de senha pela equipe, logo acima, pelo mesmo
   * motivo — o 2FA, como a senha, é da PESSOA:
   * - quem não é daqui responde como inexistente;
   * - quem trabalha também em outro provedor é recusado: desligar aqui
   *   desligaria a proteção dela lá, e este provedor não decide por aquele;
   * - o 2FA de um `owner` só um `owner` desliga — senão um `admin` tiraria o
   *   segundo fator do dono e, com a troca de senha ao lado, tomaria a conta;
   * - quem opera a plataforma é recusado: o 2FA dela protege o console;
   * - a si mesmo, não: o cartão da própria conta faz isso com senha e código.
   * Nesses casos, o comando do servidor (`skygenpanel reset-mfa`) é a saída.
   */
  static async resetMfa(req, res) {
    try {
      const tenantId = tenantOf(req);
      const id = Number(req.params?.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json(createErrorResponse(req.t('users.invalidId')));
      }
      if (id === req.user.userId) {
        return res.status(400).json(createErrorResponse(req.t('users.mfaResetSelf')));
      }
      const membership = await TenantUser.find(tenantId, id);
      const user = membership ? await User.findById(id) : null;
      if (!membership || !user) {
        return res.status(404).json(createErrorResponse(req.t('users.notFound')));
      }
      if (presentRole(membership.role) === 'owner' && presentRole(req.user.role) !== 'owner') {
        return res.status(403).json(createErrorResponse(req.t('users.ownerOnly')));
      }
      if ((await TenantUser.listForUser(id)).length > 1) {
        return res.status(409).json(createErrorResponse(req.t('users.mfaElsewhere'), null, 'mfa_elsewhere'));
      }
      if (await PlatformAdmin.has(id)) {
        return res.status(409).json(createErrorResponse(req.t('users.mfaPlatform'), null, 'mfa_platform'));
      }
      if (!user.totp_enabled_at) {
        return res.status(409).json(createErrorResponse(req.t('auth.mfaNotEnabled'), null, 'mfa_not_enabled'));
      }

      await MfaService.resetForUser(id);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.OPERATOR_MFA_RESET,
        subjectType: 'tenant_user',
        subjectId: id,
        detail: { username: user.username }
      });
      return res.json(createResponse(req.t('users.mfaReset'), { id, mfaEnabled: false }));
    } catch (error) {
      console.error('Reset MFA error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('users.updateFailed'), error.message)
      );
    }
  }
}

export default UsersController;

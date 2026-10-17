import SubscriptionService, { PlanLimitError } from '../services/subscriptionService.js';
import { planLimitResponse } from '../utils/planLimit.js';
import { getDb } from '../config/database.js';
import TenantUser from '../models/TenantUser.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { runInTenant } from '../config/tenantContext.js';
import { ROLES, applyRoleSideEffects } from './usersController.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { normalizeRole, roleHas } from '../config/permissions.js';
import TenantInvite from '../models/TenantInvite.js';
import AuthTicket from '../models/AuthTicket.js';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import {
  MAX_TTL_MS,
  MIN_TTL_MS,
  PASSWORD_SETUP_TTL_MS,
  inviteLink,
  passwordSetupLink,
  publicInvite,
  sendInvite,
  sendPasswordSetup
} from '../services/inviteDelivery.js';
import { createResponse, createErrorResponse, isValidEmail } from '../utils/helpers.js';

/**
 * Who works for a provider, decided from the control plane.
 *
 * `/api/users` answers the same question from INSIDE one provider, and the
 * difference between the two is the whole reason this file exists. Wave 12
 * refused to let a provider's own administrator attach a person who already
 * exists on the deployment: that request carries a password, there is one
 * password per person, so "attach maria" would reset the login of a stranger
 * who works for somebody else, sign her out everywhere, and hand the caller
 * working credentials at another ISP — from guessing a username.
 *
 * A platform administrator is a different trust level: they can already mint
 * providers, so reaching between them is not an escalation. They are therefore
 * who attaches an existing person to a provider — and the operation here NEVER
 * touches the password. It writes a membership and nothing else. That is not an
 * omission to be filled in later: a password field on this route would recreate
 * exactly the hazard wave 12 refused, one plane up, where it would be worse.
 *
 * Every route below names its provider in the path rather than reading
 * `req.tenantId`. The scope a platform administrator's own session runs in is
 * whichever provider they happen to work for, and it has nothing to do with the
 * provider they are administering. `tenant_users`, `users` and `tenants` are
 * all shared tables read through `getDb()` rather than `tdb`, so naming the
 * provider in the path is not fighting the scope — it is the only thing that
 * decides which provider these routes act on.
 *
 * E é por isso que attach e detach gravam DUAS trilhas, como a suspensão em
 * `platformController.setStatus` já grava. Um vínculo escrito daqui vira uma
 * sessão legítima dentro de um ISP — cadastro inteiro, senhas de portal,
 * exportação — e escrever só em `platform_audit` deixaria a única cópia do
 * registro na trilha de quem agiu, que é a trilha que o ISP não pode ler. A
 * linha espelhada no `audit_log` DAQUELE provedor, com `actorKind: 'platform'`,
 * é o que permite ao ISP ver que uma mão de fora mexeu na equipe dele. Nenhuma
 * das duas é condição da ação: o vínculo já foi escrito quando elas falham, e
 * derrubar a resposta ali só produziria uma segunda tentativa — a exceção que
 * confere o retorno é a exclusão de provedor, onde a trilha é condição.
 */

/**
 * O papel tal como vale. Mesma função que `/api/users` usa, e importada da
 * matriz em vez de repetida: o plano de controle não pode reportar para uma
 * linha um papel que a tela do próprio provedor soletra de outro jeito, e duas
 * cópias da regra divergem no primeiro papel novo.
 */
/** O mesmo custo de `/api/users` e do aceite do convite. */
const BCRYPT_ROUNDS = 12;

const presentRole = normalizeRole;

/** Os papéis que administram a equipe, derivados da matriz — ver `usersController`. */
const ADMINISTRADORES = ROLES.filter((role) => roleHas(role, 'operators.manage'));

/** The `TenantMembership` the panel's API contract asks for. */
function present(member) {
  return {
    userId: member.id,
    username: member.username,
    email: member.email ?? null,
    phone: member.phone ?? null,
    role: presentRole(member.role)
  };
}

/**
 * O telefone lido do corpo: `undefined` quando não veio, `''` para apagar, os
 * dígitos normalizados, ou `null` quando veio e não é telefone.
 */
function readPhone(raw) {
  if (raw === undefined) return undefined;
  const texto = String(raw ?? '').trim();
  if (!texto) return '';
  const digitos = normalizarTelefoneBr(texto);
  return digitos || null;
}

/**
 * O provedor e a pessoa nomeados no caminho, e o vínculo entre eles — ou a
 * resposta de erro já enviada. Uma pessoa de OUTRO provedor responde 404: o
 * console age sobre a equipe do provedor da URL, e só sobre ela.
 */
async function loadMember(req, res) {
  const tenantId = parseId(req.params?.id);
  const userId = parseId(req.params?.userId);
  if (!tenantId) {
    res.status(400).json(createErrorResponse('Invalid provider id'));
    return null;
  }
  if (!userId) {
    res.status(400).json(createErrorResponse('Invalid operator id'));
    return null;
  }
  const tenant = await findTenant(tenantId);
  if (!tenant) {
    tenantNotFound(res);
    return null;
  }
  const membership = await TenantUser.find(tenantId, userId);
  const person = membership ? await User.findById(userId) : null;
  if (!membership || !person) {
    res.status(404).json(createErrorResponse('Membership not found'));
    return null;
  }
  return { tenant, tenantId, userId, membership, person };
}

/** As duas trilhas de uma ação sobre uma conta da equipe. */
async function recordMemberAction(req, { tenant, tenantId, userId }, platformAction, tenantAction, detail) {
  await PlatformAudit.fromRequest(req, { action: platformAction, tenant, detail: { userId, ...detail } });
  await runInTenant(tenantId, () => AuditLog.fromRequest(req, {
    action: tenantAction,
    actorKind: 'platform',
    subjectType: 'tenant_user',
    subjectId: userId,
    detail
  }));
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The provider named in the path, or null.
 *
 * Read straight from `tenants` rather than through a model: there is none yet,
 * and this is a single existence check. It is here so that a bad id answers 404
 * instead of writing a membership at a provider that is not there — the foreign
 * key would catch it, but as a 500 with a driver's words in it.
 */
async function findTenant(id) {
  return (await getDb()('tenants').where({ id }).first()) || null;
}

/**
 * A provider that does not exist says so, plainly.
 *
 * `/api/users` answers 404 for somebody who works elsewhere precisely so that a
 * prober cannot map the deployment. Here that reasoning is inverted: listing
 * every provider is this caller's own first screen, so hiding which ids exist
 * from them would protect nothing and would turn a mistyped id into a silent
 * empty team.
 */
function tenantNotFound(res) {
  return res.status(404).json(createErrorResponse('Provider not found'));
}

class PlatformMemberController {
  /** Everyone who works for one provider, with the role they hold THERE. */
  static async list(req, res) {
    try {
      const tenantId = parseId(req.params?.id);
      if (!tenantId) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      if (!(await findTenant(tenantId))) return tenantNotFound(res);

      const members = await TenantUser.listForTenant(tenantId);
      return res.json(createResponse('Memberships retrieved successfully', {
        memberships: members.map(present)
      }));
    } catch (error) {
      console.error('List memberships error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to list the provider members', error.message)
      );
    }
  }

  /**
   * Convida a primeira pessoa de um provedor — ou qualquer pessoa que ainda não
   * tenha login neste deploy.
   *
   * Isto era um beco sem saída, e o beco tinha quatro paredes. Um provedor
   * recém-criado pelo console não tinha equipe, e nenhum caminho levava a
   * primeira conta até ele: `add` (abaixo) só vincula quem JÁ existe e não tem
   * campo de senha, por desenho; o `/setup` no host do provedor novo responde
   * "já concluído", porque ele conta a tabela `users`, que é do deploy inteiro;
   * `POST /api/invites` é escopado e exige uma sessão DENTRO do provedor que
   * ainda não tem ninguém para abrir sessão; e a personificação é só de
   * leitura. O ISP recebia um painel que ninguém conseguia abrir.
   *
   * O convite é a saída certa, e não um formulário de senha aqui. A pessoa
   * escolhe a própria senha ao aceitar — o plano de controle nunca a conhece,
   * que é a mesma linha que `add` traça ao não ter campo de senha. E o link é um
   * segredo com validade, não um endereço aberto: consertar o `/setup` para
   * contar por provedor também resolveria o beco, mas deixaria
   * `provedor.painel.exemplo.com/setup` aberto a quem chegasse primeiro num
   * endereço fácil de adivinhar, e quem chegasse primeiro viraria dono.
   *
   * O papel não tem a trava de `inviteController`, onde um `admin` não cunha um
   * `owner`. Aqui é o contrário por necessidade: é ESTE plano que entrega o
   * provedor ao primeiro dono dele, e um convite de `owner` é exatamente o que
   * a criação de um provedor precisa emitir.
   *
   * Duas trilhas, como todo write deste arquivo: a nossa registra que a
   * plataforma cunhou um convite para aquele provedor, e a DELE registra o
   * convite com `actorKind: 'platform'` — a mesma ação que a tela de trilha do
   * provedor já lê, para que o ISP veja que a mão veio de fora.
   */
  static async invite(req, res) {
    try {
      const tenantId = parseId(req.params?.id);
      if (!tenantId) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      // A linha inteira: o slug e o nome vão para a trilha, e o slug é o que
      // monta o endereço em que o convite é aceito.
      const tenant = await findTenant(tenantId);
      if (!tenant) return tenantNotFound(res);

      const role = req.body?.role;
      if (!ROLES.includes(role)) {
        return res.status(400).json(
          createErrorResponse(`Role must be one of: ${ROLES.join(', ')}`)
        );
      }

      const ttlMs = req.body?.ttlMs === undefined
        ? TenantInvite.DEFAULT_TTL_MS
        : Number(req.body.ttlMs);
      if (!Number.isFinite(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
        return res.status(400).json(
          createErrorResponse('An invitation must be valid for between 30 minutes and 30 days')
        );
      }

      // O endereço é opcional e só decide se o link TAMBÉM vai por e-mail. Um
      // endereço inválido é recusado ANTES de o convite existir, para não deixar
      // convite órfão de um erro de digitação.
      const email = User.normalizeEmail(req.body?.email);
      if (req.body?.email !== undefined && (!email || !isValidEmail(email))) {
        return res.status(400).json(createErrorResponse('Invalid e-mail address'));
      }

      // `tenant_invites` é escopada e o escopo aberto por `authenticateToken` é
      // o do provedor em que o administrador da plataforma trabalha — que não é
      // este. Sem `runInTenant` o convite nasceria no provedor errado e poria
      // um estranho na equipe de quem cunhou.
      const { invite, token } = await runInTenant(tenantId, () => TenantInvite.create({
        role,
        label: req.body?.label,
        createdBy: req.user?.userId ?? null,
        ttlMs
      }));

      // O token NÃO entra em trilha nenhuma. Ele é a credencial: quem tem o
      // link entra na equipe com o papel escrito nele, e guardá-lo faria da
      // trilha uma lista de convites utilizáveis.
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.MEMBER_INVITED,
        tenant,
        detail: { inviteId: invite.id, role, expiresAt: invite.expires_at }
      });
      await runInTenant(tenantId, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.INVITE_CREATED,
        actorKind: 'platform',
        subjectType: 'invite',
        subjectId: invite.id,
        detail: { role, expiresAt: invite.expires_at }
      }));

      // O envio vem DEPOIS de o convite existir e da trilha estar escrita, e o
      // resultado dele não muda o status: o convite foi criado, e é isso que o
      // 201 diz. Um deploy sem SMTP devolve `emailed: false` com o link na mão,
      // que é como quem convidou entregaria de qualquer jeito.
      const emailed = email ? await sendInvite({ req, tenant, email, token }) : false;

      return res.status(201).json(createResponse('Invitation created', {
        invite: publicInvite(invite),
        // Uma vez só: a tabela guarda o hash, então nem esta rota nem nenhuma
        // outra consegue dizer isto de novo.
        token,
        // Montado aqui, e não pela tela: o convite é aceito no host do PROVEDOR
        // e o console vive em outro endereço, então é a única parte do link que
        // o navegador de quem convidou não tem como saber. `null` num deploy sem
        // domínio-base configurado.
        url: inviteLink(tenant, token),
        emailed
      }));
    } catch (error) {
      console.error('Invite to provider error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to create the invitation', error.message)
      );
    }
  }

  /**
   * Cria um operador NOVO dentro de um provedor, do console.
   *
   * É a terceira porta desta tela, e ela existe porque as outras duas não
   * servem a um provedor ADMINISTRADO — aquele que a plataforma opera em nome
   * do ISP. `add` exige alguém que já tenha login; o convite exige que a pessoa
   * do outro lado escolha nome de usuário e senha, o que é atrito quando quem
   * vai operar o painel é a própria plataforma, ou quando o ISP só quer receber
   * um acesso pronto.
   *
   * Duas entregas, e a diferença entre elas é quem conhece a senha:
   *
   * - **link** (padrão): a conta nasce com uma senha aleatória que ninguém vê —
   *   nem quem a criou — e a pessoa escolhe a dela abrindo um bilhete de uso
   *   único no endereço do provedor. É o mesmo `auth_tickets` da redefinição
   *   comum, com o mesmo resgate preso ao host; o que muda é quem cunha e o
   *   prazo (ver `PASSWORD_SETUP_TTL_MS`).
   * - **senha digitada**: quem opera o console escolhe a senha e a entrega. É o
   *   que o cabeçalho deste arquivo recusa para `add`, e a recusa continua
   *   valendo lá: uma senha naquela rota RESETARIA o login de um estranho que
   *   já existe e trabalha noutro lugar. Aqui a conta está sendo criada agora e
   *   ainda não é de ninguém, então o que se perde é outra coisa, menor e
   *   assumida: a plataforma conhece a senha inicial daquela conta até a pessoa
   *   trocá-la. Quem escolhe é quem opera, e o padrão da tela é o link.
   *
   * O que esta rota NUNCA faz é tocar em conta que já existe: `loginConflict`
   * recusa nome e endereço já usados com 409, e é isso que a separa de `add`.
   */
  static async createOperator(req, res) {
    try {
      const tenantId = parseId(req.params?.id);
      if (!tenantId) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const tenant = await findTenant(tenantId);
      if (!tenant) return tenantNotFound(res);

      const username = String(req.body?.username ?? '').trim();
      const email = User.normalizeEmail(req.body?.email);
      const role = req.body?.role;
      const phone = readPhone(req.body?.phone);
      if (phone === null) {
        return res.status(400).json(createErrorResponse('Invalid phone number', null, 'invalid_phone'));
      }
      // A senha é opcional: sem ela, o caminho é o link. Lida como veio, sem
      // `trim()` — espaço nas pontas de uma senha é senha.
      const mandouSenha = req.body?.password !== undefined && req.body?.password !== null;
      const password = mandouSenha ? String(req.body.password) : null;

      if (username.length < 3 || username.length > 64) {
        return res.status(400).json(
          createErrorResponse('Username must be between 3 and 64 characters')
        );
      }
      // Obrigatório, como em `/api/users`: é por ele que a pessoa recebe o link
      // e é por ele que ela recupera a conta depois.
      if (!email || !isValidEmail(email)) {
        return res.status(400).json(createErrorResponse('Invalid e-mail address'));
      }
      if (!ROLES.includes(role)) {
        return res.status(400).json(
          createErrorResponse(`Role must be one of: ${ROLES.join(', ')}`)
        );
      }
      if (mandouSenha && (password.length < 8 || password.length > 128)) {
        return res.status(400).json(
          createErrorResponse('Password must be between 8 and 128 characters')
        );
      }

      const conflito = await User.loginConflict({ username, email });
      if (conflito) {
        // O código vai junto para a tela dizer QUAL dos dois está tomado sem
        // ter que reconhecer a frase do plano de controle, que é em inglês.
        return res.status(409).json(createErrorResponse(
          conflito === 'email_taken' ? 'E-mail already taken' : 'Username already taken',
          null,
          conflito
        ));
      }

      // O limite é do provedor ALVO, não do provedor em que quem opera o
      // console trabalha — daí abrir o escopo dele para perguntar.
      try {
        await runInTenant(tenantId, () => SubscriptionService.assertCanAddOperator());
      } catch (error) {
        if (error instanceof PlanLimitError) return planLimitResponse(req, res, error);
        throw error;
      }

      // Sem senha digitada, a coluna — que é `NOT NULL` — recebe 32 bytes
      // aleatórios. Não é uma senha vazia nem uma senha padrão: é uma senha que
      // ninguém sabe, nem quem acabou de criar a conta, e que só sai do caminho
      // quando a pessoa resgata o bilhete.
      const segredo = mandouSenha ? password : crypto.randomBytes(32).toString('hex');
      const hash = await bcrypt.hash(segredo, BCRYPT_ROUNDS);

      // A pessoa e o vínculo numa transação só: uma pessoa sem vínculo não
      // entra em lugar nenhum e não aparece em tela nenhuma — é lixo que só o
      // banco enxerga.
      const userId = await getDb().transaction(async (trx) => {
        const id = await User.create({ username, password: hash, role, email, phone: phone || null }, trx);
        await TenantUser.create({ tenantId, userId: id, role }, trx);
        return id;
      });

      // O bilhete vem DEPOIS de a conta existir, e só no caminho do link.
      let token = null;
      if (!mandouSenha) {
        ({ token } = await AuthTicket.create({
          purpose: AuthTicket.PURPOSES.PASSWORD_RESET,
          userId,
          tenantId,
          email,
          ttlMs: PASSWORD_SETUP_TTL_MS
        }));
      }

      // As duas trilhas, como todo write deste arquivo. `mode` fica no detalhe
      // porque a pergunta "quem conheceu a senha inicial desta conta" tem que
      // ter resposta — e a resposta é esta linha.
      const detail = { userId, username, role, mode: mandouSenha ? 'password' : 'link' };
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.OPERATOR_CREATED,
        tenant,
        detail
      });
      await runInTenant(tenantId, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.OPERATOR_CREATED,
        actorKind: 'platform',
        subjectType: 'tenant_user',
        subjectId: userId,
        detail
      }));

      const emailed = token ? await sendPasswordSetup({ req, tenant, email, token }) : false;

      return res.status(201).json(createResponse('Operator created', {
        membership: present({ id: userId, username, email, phone: phone || null, role }),
        // Mostrado uma vez, como o token do convite: o banco guarda só o hash.
        // `null` quando a senha foi digitada — ali não há o que entregar além
        // dela mesma.
        url: token ? passwordSetupLink(tenant, token) : null,
        token,
        emailed
      }));
    } catch (error) {
      console.error('Create operator error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to create the operator', error.message)
      );
    }
  }

  /**
   * Attaches a person who already exists to a provider.
   *
   * The person must already exist. Creating one is `/api/users`' job, at a
   * provider, where the request carries a password chosen by whoever typed it
   * — and this route has no password field by design. Creating from here would
   * have to invent one of two bad things: an account whose password the
   * platform administrator knows, or an account with no usable password that
   * nobody can sign in to. So an unknown username is refused and says so: this
   * caller is trusted with the whole deployment, and hiding from them which
   * usernames exist would only make the screen unusable.
   */
  static async add(req, res) {
    try {
      const tenantId = parseId(req.params?.id);
      if (!tenantId) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      // A linha do provedor, e não só a confirmação de que ele existe: o slug e
      // o nome vão para a trilha da plataforma junto com o id, como em toda
      // linha daquela tabela, para que ela siga legível quando o provedor não
      // existir mais.
      const tenant = await findTenant(tenantId);
      if (!tenant) return tenantNotFound(res);

      const username = String(req.body?.username ?? '').trim();
      const role = req.body?.role;
      if (!username) {
        return res.status(400).json(createErrorResponse('Username is required'));
      }
      // The same vocabulary `/api/users` writes, imported rather than repeated:
      // a membership role written here is read by that screen, and two lists
      // that drifted apart would let the control plane write a role the
      // provider's own team screen cannot display.
      if (!ROLES.includes(role)) {
        return res.status(400).json(
          createErrorResponse(`Role must be one of: ${ROLES.join(', ')}`)
        );
      }

      // Nome OU e-mail: o plano de controle anexa uma pessoa que já existe, e
      // depois desta versão ela é conhecida pelo endereço tanto quanto pelo
      // nome. Procurar só pelo nome faria a rota não achar quem já migrou.
      const person = await User.findByLogin(username);
      if (!person) {
        // Com `code`, e não só com a frase: esta é a recusa que a tela precisa
        // TRADUZIR e transformar em instrução — quem não existe no deploy entra
        // pelo convite, que é a rota ao lado —, e ler isso de uma frase em
        // inglês do plano de controle seria adivinhação por texto.
        return res.status(404).json(
          createErrorResponse('No such person on this deployment', null, 'person_not_found')
        );
      }
      // Refused rather than written twice. `tenant_users` is unique on
      // (tenant_id, user_id), so the second insert would fail on the
      // constraint; catching it here is the difference between "she already
      // works here" on screen and a 500 carrying a driver's message. Changing
      // the role of a membership that exists is the provider's own decision,
      // through `/api/users`, and doing it silently from this route would let
      // the control plane demote an ISP's administrator through a call that
      // reads as "add".
      if (await TenantUser.find(tenantId, person.id)) {
        return res.status(409).json(
          createErrorResponse('This person already works for this provider')
        );
      }

      // The one write. No `users` row is touched: not the password, not the
      // deployment-wide role, not `token_version`. The person's open sessions
      // stay valid because nothing about them changed — a new membership takes
      // effect when they sign in and choose this provider, and revoking here
      // would sign them out of the ISP they are working at right now to tell
      // them about a job they have just been given.
      // O limite é do provedor ALVO, não do provedor em que o administrador da
      // plataforma está logado — daí abrir o escopo dele para perguntar.
      try {
        await runInTenant(tenantId, () => SubscriptionService.assertCanAddOperator());
      } catch (error) {
        if (error instanceof PlanLimitError) return planLimitResponse(req, res, error);
        throw error;
      }

      await TenantUser.create({ tenantId, userId: person.id, role });

      // Quem agiu, em qual provedor, quem foi vinculado e com que papel. O
      // `detail` não carrega nada da pessoa além do nome e do id: a senha não
      // passa por esta rota e o hash não tem por que aparecer numa trilha.
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.MEMBER_ADDED,
        tenant,
        detail: { userId: person.id, username: person.username, role }
      });
      // A mesma ação, na trilha do provedor afetado — `runInTenant` porque
      // `audit_log` é escopada e o escopo aberto por `authenticateToken` é o do
      // provedor em que o administrador da plataforma trabalha, que não é este.
      // A ação reaproveita o vocabulário que a tela de trilha do provedor já
      // lê; o que diz que a mão veio de fora é `actorKind: 'platform'`.
      await runInTenant(tenantId, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.OPERATOR_CREATED,
        actorKind: 'platform',
        subjectType: 'tenant_user',
        subjectId: person.id,
        detail: { username: person.username, role }
      }));

      return res.status(201).json(createResponse('Membership created successfully', {
        membership: present({ ...person, role })
      }));
    } catch (error) {
      console.error('Add membership error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to attach the person to the provider', error.message)
      );
    }
  }

  /**
   * Ends the membership. The person stays, always.
   *
   * They may work for another provider, and their name is on history that
   * points at `users.id` — who sent that message, who revoked that opt-out, who
   * created that campaign. Those three foreign keys are ON DELETE SET NULL, so
   * deleting the person would not fail loudly: it would quietly blank the
   * record of who did what, at every provider they ever worked for.
   */
  static async remove(req, res) {
    try {
      const tenantId = parseId(req.params?.id);
      const userId = parseId(req.params?.userId);
      if (!tenantId) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      if (!userId) {
        return res.status(400).json(createErrorResponse('Invalid operator id'));
      }
      const tenant = await findTenant(tenantId);
      if (!tenant) return tenantNotFound(res);

      const membership = await TenantUser.find(tenantId, userId);
      if (!membership) {
        return res.status(404).json(createErrorResponse('Membership not found'));
      }

      // The membership this session is running on. Ending it would 403 the
      // caller's very next request — `authenticateToken` re-reads the row on
      // every call — so the control-plane screen would appear to break at the
      // moment it succeeded. A platform administrator who really means to leave
      // a provider can do it from a session at another one; refusing costs them
      // that, and saves everyone else an unexplained logout.
      if (userId === req.user.userId && tenantId === req.user.tenantId) {
        return res.status(409).json(
          createErrorResponse('You cannot end the membership your own session runs on')
        );
      }

      // The last administrator of a provider, removed by somebody who does not
      // work there.
      //
      // `/api/users` refuses this, and so does this route, but not for the same
      // reason. There the argument is that nobody left inside the provider
      // could undo it. Here that argument does not hold: the caller holds the
      // repair tool, and one POST to this same route puts an administrator
      // back. The reason it is still refused is that the panel already HAS an
      // operation for taking a provider out of service — `tenants.status`,
      // which `forEachTenant`, the media sweep and the SGP webhook all honour,
      // and which is recorded on the provider and reversible in one click.
      // Stripping the last administrator reaches a state that looks the same to
      // the ISP's staff (nobody can manage anything) while the control plane's
      // own provider list still shows it active, so nothing on any screen says
      // why the phone is ringing. Two ways to disable a provider, one of them
      // invisible, is worth more than the ability to do staff churn in any
      // order: the platform administrator attaches the replacement first, and
      // then removes the outgoing one.
      //
      // Note what is counted: administrators OF THIS PROVIDER. Counting across
      // the deployment — as the guard did before `tenant_users` existed — would
      // be wrong in both directions at once, letting another ISP's admins
      // authorise emptying this one.
      if (roleHas(membership.role, 'operators.manage')
        && await TenantUser.countByRoles(tenantId, ADMINISTRADORES) <= 1) {
        return res.status(409).json(
          createErrorResponse('A provider must keep at least one administrator')
        );
      }

      // Lido ANTES da remoção porque é o nome que as duas trilhas vão registrar
      // — o id sozinho não diz a ninguém quem saiu, e daqui a um ano pode não
      // haver mais a quem perguntar. A pessoa sobrevive à remoção, então isto é
      // conveniência de leitura e não uma corrida.
      const person = await User.findById(userId);
      const role = presentRole(membership.role);

      await TenantUser.remove(tenantId, userId);

      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.MEMBER_REMOVED,
        tenant,
        detail: { userId, username: person?.username ?? null, role }
      });
      // E no provedor que perdeu a pessoa, pelo mesmo motivo da suspensão: quem
      // vai perguntar "cadê o fulano da minha equipe" é o ISP, e a resposta tem
      // que estar onde ele consegue olhar.
      await runInTenant(tenantId, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.OPERATOR_REMOVED,
        actorKind: 'platform',
        subjectType: 'tenant_user',
        subjectId: userId,
        detail: { username: person?.username ?? null, role }
      }));

      // Deliberately no session revocation, which is where this parts company
      // with `/api/users`. `token_version` lives on the PERSON, so bumping it
      // signs them out of every provider they work for, and this operation is
      // about one. It is not needed for safety either: the membership is read
      // back from the table on every authenticated request, so the session that
      // named this provider stops working at its next call regardless — while
      // the shift they may be working at another ISP carries on, which is the
      // only difference the bump would have made.
      return res.json(createResponse('Membership ended successfully', { userId }));
    } catch (error) {
      console.error('Remove membership error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to end the membership', error.message)
      );
    }
  }

  /**
   * `PATCH /api/platform/tenants/:id/members/:userId` — `{ role?, username?, email?, phone? }`.
   *
   * O papel é DESTE provedor. Login, e-mail e telefone são da PESSOA: quem
   * trabalha em mais de um provedor muda nos dois, e a resposta diz isso
   * (`sharedAccount`) para a tela avisar antes de alguém estranhar.
   *
   * A regra "só o dono promove dono" de `/api/users` não vale aqui, pela mesma
   * razão de `add` e `invite`: o console está acima do provedor. A do último
   * administrador vale, pelo motivo escrito em `remove`.
   */
  static async update(req, res) {
    try {
      const alvo = await loadMember(req, res);
      if (!alvo) return undefined;
      const { tenantId, userId, membership, person } = alvo;
      const corpo = req.body ?? {};
      const mudancas = {};

      if (corpo.role !== undefined) {
        if (!ROLES.includes(corpo.role)) {
          return res.status(400).json(createErrorResponse(`Role must be one of: ${ROLES.join(', ')}`));
        }
        if (presentRole(corpo.role) !== presentRole(membership.role)) {
          const eraAdmin = roleHas(membership.role, 'operators.manage');
          const seraAdmin = roleHas(corpo.role, 'operators.manage');
          if (eraAdmin && !seraAdmin && await TenantUser.countByRoles(tenantId, ADMINISTRADORES) <= 1) {
            return res.status(409).json(createErrorResponse('A provider must keep at least one administrator'));
          }
          mudancas.role = { from: presentRole(membership.role), to: presentRole(corpo.role) };
        }
      }

      let username;
      if (corpo.username !== undefined) {
        username = String(corpo.username ?? '').trim();
        if (username.length < 3 || username.length > 64) {
          return res.status(400).json(createErrorResponse('Username must be between 3 and 64 characters'));
        }
        if (username !== person.username) mudancas.username = { from: person.username, to: username };
      }

      let email;
      if (corpo.email !== undefined) {
        email = User.normalizeEmail(corpo.email);
        if (!email || !isValidEmail(email)) {
          return res.status(400).json(createErrorResponse('Invalid e-mail address'));
        }
        if (email !== (person.email ?? null)) mudancas.email = { from: person.email ?? null, to: email };
      }

      const phone = readPhone(corpo.phone);
      if (phone === null) {
        return res.status(400).json(createErrorResponse('Invalid phone number', null, 'invalid_phone'));
      }
      if (phone !== undefined && (phone || null) !== (person.phone ?? null)) {
        mudancas.phone = { from: person.phone ?? null, to: phone || null };
      }

      if (mudancas.username || mudancas.email) {
        const conflito = await User.loginConflict({
          username: mudancas.username ? username : null,
          email: mudancas.email ? email : null,
          exceptId: userId
        });
        if (conflito) {
          return res.status(409).json(createErrorResponse(
            conflito === 'email_taken' ? 'E-mail already taken' : 'Username already taken',
            null,
            conflito
          ));
        }
      }

      if (mudancas.role) {
        await TenantUser.setRole(tenantId, userId, corpo.role);
        await applyRoleSideEffects(userId, corpo.role);
      }
      if (mudancas.username) await User.updateUsername(userId, username);
      if (mudancas.email) await User.updateEmail(userId, email);
      if (mudancas.phone) await User.updatePhone(userId, phone);

      if (Object.keys(mudancas).length) {
        await recordMemberAction(
          req, alvo,
          PlatformAudit.ACTIONS.MEMBER_UPDATED,
          AuditLog.ACTIONS.OPERATOR_UPDATED,
          { username: username ?? person.username, changes: mudancas }
        );
      }

      const depois = await User.findById(userId);
      const vinculo = await TenantUser.find(tenantId, userId);
      const memberships = await TenantUser.listForUser(userId);
      return res.json(createResponse('Membership updated', {
        membership: present({ ...depois, role: vinculo.role }),
        sharedAccount: memberships.length > 1
      }));
    } catch (error) {
      console.error('Update membership error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the member', error.message));
    }
  }

  /**
   * `POST .../members/:userId/password-link` — `{ sendEmail? }`.
   *
   * Um link novo de definir senha, que invalida o anterior (`AuthTicket.create`
   * queima os abertos do mesmo propósito). Devolvido UMA vez, como no
   * `createOperator`, para quem opera copiar ou mandar pelo WhatsApp; o banco
   * guarda só o hash, e nenhuma trilha guarda o link.
   */
  static async passwordLink(req, res) {
    try {
      const alvo = await loadMember(req, res);
      if (!alvo) return undefined;
      const { tenant, tenantId, userId, person } = alvo;
      const { token } = await AuthTicket.create({
        purpose: AuthTicket.PURPOSES.PASSWORD_RESET,
        userId,
        tenantId,
        email: person.email ?? null,
        ttlMs: PASSWORD_SETUP_TTL_MS
      });
      const querEmail = req.body?.sendEmail === true;
      const emailed = querEmail && person.email
        ? await sendPasswordSetup({ req, tenant, email: person.email, token })
        : false;
      await recordMemberAction(
        req, alvo,
        PlatformAudit.ACTIONS.MEMBER_PASSWORD_LINK_ISSUED,
        AuditLog.ACTIONS.OPERATOR_PASSWORD_LINK_ISSUED,
        { username: person.username, emailed }
      );
      return res.json(createResponse('Password link issued', {
        url: passwordSetupLink(tenant, token),
        token,
        emailed,
        expiresInMs: PASSWORD_SETUP_TTL_MS
      }));
    } catch (error) {
      console.error('Member password link error:', error);
      return res.status(500).json(createErrorResponse('Failed to issue the password link', error.message));
    }
  }

  /**
   * `POST .../members/:userId/password` — `{ password }`.
   *
   * A senha definida por quem opera o console. `updatePassword` encerra as
   * sessões da pessoa, em todo provedor — a senha é uma só.
   */
  static async setPassword(req, res) {
    try {
      const alvo = await loadMember(req, res);
      if (!alvo) return undefined;
      const password = req.body?.password === undefined || req.body?.password === null
        ? ''
        : String(req.body.password);
      if (password.length < 8 || password.length > 128) {
        return res.status(400).json(createErrorResponse('Password must be between 8 and 128 characters'));
      }
      await User.updatePassword(alvo.userId, await bcrypt.hash(password, BCRYPT_ROUNDS));
      await recordMemberAction(
        req, alvo,
        PlatformAudit.ACTIONS.MEMBER_PASSWORD_SET,
        AuditLog.ACTIONS.OPERATOR_PASSWORD_SET,
        { username: alvo.person.username }
      );
      return res.json(createResponse('Password updated', { userId: alvo.userId }));
    } catch (error) {
      console.error('Member set password error:', error);
      return res.status(500).json(createErrorResponse('Failed to set the password', error.message));
    }
  }

  /**
   * `POST .../members/:userId/sessions/revoke` — derruba toda sessão da pessoa.
   *
   * `token_version` é da pessoa, então vale em todo provedor dela: é para o
   * caso "o celular com o painel aberto foi perdido", em que é isso mesmo que
   * se quer.
   */
  static async revokeSessions(req, res) {
    try {
      const alvo = await loadMember(req, res);
      if (!alvo) return undefined;
      await User.revokeSessions(alvo.userId);
      await recordMemberAction(
        req, alvo,
        PlatformAudit.ACTIONS.MEMBER_SESSIONS_REVOKED,
        AuditLog.ACTIONS.OPERATOR_SESSIONS_REVOKED,
        { username: alvo.person.username }
      );
      return res.json(createResponse('Sessions revoked', { userId: alvo.userId }));
    } catch (error) {
      console.error('Member revoke sessions error:', error);
      return res.status(500).json(createErrorResponse('Failed to revoke the sessions', error.message));
    }
  }
}

export default PlatformMemberController;

import 'dotenv/config';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { DEVELOPMENT_FALLBACK, isProduction, assertNotPlaceholderSecret } from '../config/runtimeEnv.js';
import TenantUser from '../models/TenantUser.js';
import PlatformAdmin from '../models/PlatformAdmin.js';
import Tenant, { mfaRequired } from '../models/Tenant.js';
import { runInTenant, runUnscoped } from '../config/tenantContext.js';
import { roleHas } from '../config/permissions.js';
import { subscriptionRefusal } from './subscriptionGate.js';
import { hostMatchesTenant, usesTenantSubdomains } from './tenantResolver.js';
import { canHoldSession } from '../config/login.js';

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';

/**
 * As duas audiências do painel, e por que são duas.
 *
 * `skygenpanel-admin` é a sessão de quem trabalha para o provedor. Foi sempre
 * a única, e continua sendo a única que uma senha produz.
 *
 * `skygenpanel-platform` é a personificação: quem opera o SaaS olhando o painel
 * de um cliente para atendê-lo. Ela precisa ser um token DIFERENTE, e não uma
 * bandeira dentro do mesmo, porque a diferença tem que sobreviver a um erro de
 * leitura: um `if (decoded.impersonation)` esquecido em algum lugar trata a
 * personificação como sessão comum, mas uma audiência errada não passa pelo
 * `jwt.verify`. É a mesma razão de o portal do assinante ter a dele.
 *
 * O par não se mistura: um token de audiência de plataforma SEM a marca de
 * personificação, ou um de audiência de painel COM ela, são os dois recusados.
 * Cada audiência tem exatamente uma forma válida.
 */
const PANEL_AUDIENCE = 'skygenpanel-admin';
const PLATFORM_AUDIENCE = 'skygenpanel-platform';
/**
 * A terceira: a sessão do CONSOLE, que não pertence a provedor nenhum.
 *
 * Audiência própria e não uma marca dentro da do painel, pelo argumento que
 * este arquivo já fez duas vezes: um `if` esquecido trata uma forma como a
 * outra, e uma audiência errada não passa pelo `jwt.verify`. E não pode ser a
 * `skygenpanel-platform`, que já é a personificação — aquela NOMEIA um
 * provedor e é só leitura; esta não nomeia nenhum e age em nome da plataforma.
 */
const CONSOLE_AUDIENCE = 'skygenpanel-console';

/**
 * Meia hora, fixa, e sem refresh.
 *
 * Não usa `JWT_EXPIRES_IN` de propósito: aquela é a duração do expediente de
 * quem trabalha no painel, e um deploy pode legitimamente esticá-la para o dia
 * inteiro. A personificação é um atendimento, não um expediente — e como não
 * há refresh, continuar depois de vencida custa uma volta ao console, que é
 * mais uma linha na trilha. O incômodo é o mecanismo.
 */
const IMPERSONATION_EXPIRES_IN = '30m';

const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (secret) {
    if (isProduction() && secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters in production');
    }
    assertNotPlaceholderSecret('JWT_SECRET', secret);
    return secret;
  }
  if (isProduction()) {
    throw new Error('JWT_SECRET must be set in production');
  }
  console.warn('JWT_SECRET not set; using insecure development fallback');
  return DEVELOPMENT_FALLBACK;
})();

/**
 * Mints the pair a session runs on.
 *
 * `membership` is required rather than optional, and deliberately so. Every
 * caller — login, setup, refresh — has already worked out which provider the
 * session is for, and a token minted without one would come back to whatever
 * `resolveTenant` answers by default: a session for whichever provider happens
 * to hold the lowest id. Making the argument mandatory turns that mistake into
 * a crash on the first call instead of a quiet cross-provider read in
 * production.
 *
 * The role written into the token is the MEMBERSHIP's, never `users.role`. The
 * same person can be an administrator at the ISP they own and an ordinary
 * operator at one they consult for, and `requirePermission` reads what is here.
 *
 * The refresh token carries `tenantId` as well, because it has to be able to
 * mint the same thing again: without it a refresh would have to guess the
 * provider back, which is the guess this whole change exists to remove.
 */
function generateTokens(user, membership) {
  const tenantId = Number(membership?.tenant_id ?? membership?.tenantId);
  const role = membership?.role;
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !role) {
    throw new Error('generateTokens needs the membership the session is for');
  }

  const commonOptions = {
    issuer: 'skygenpanel',
    audience: PANEL_AUDIENCE
  };
  const accessToken = jwt.sign(
    {
      userId: user.id,
      username: user.username,
      tenantId,
      role,
      tokenVersion: Number(user.token_version || 0)
    },
    JWT_SECRET,
    { ...commonOptions, expiresIn: JWT_EXPIRES_IN }
  );

  const refreshToken = jwt.sign(
    {
      userId: user.id,
      tenantId,
      tokenType: 'refresh',
      tokenVersion: Number(user.token_version || 0)
    },
    JWT_SECRET,
    { ...commonOptions, expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );

  return { accessToken, refreshToken };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: 'skygenpanel',
      audience: [PANEL_AUDIENCE, PLATFORM_AUDIENCE, CONSOLE_AUDIENCE]
    });
  } catch {
    return null;
  }
}

/**
 * O token de uma personificação. Só o de acesso: não existe refresh.
 *
 * `role` (`IMPERSONATION_ROLE`) está escrito aqui e é reafirmado na hidratação, que não lê
 * o papel do token. Os dois de propósito: o que está no token é o registro do
 * que a sessão era, e o que a hidratação impõe é o que ela pode. Um token
 * forjado com `role: 'owner'` — que exigiria a chave, mas ainda assim — não
 * ganharia nada, porque o papel que a requisição usa não vem daqui.
 *
 * `tokenVersion` é o de quem PERSONIFICA, não o do provedor personificado: é a
 * sessão dessa pessoa que está aberta, e trocar a senha dela tem que derrubá-la
 * aqui como derruba em qualquer outro lugar.
 */
/**
 * O papel de uma sessão de atendimento: `admin`, o conjunto inteiro do painel.
 *
 * Era `viewer`, e a sessão não abria nem o detalhe de um equipamento (a
 * capacidade `devices.inspect` é do plantão para cima). A plataforma atende o
 * provedor mexendo no painel dele — WiFi, PPPoE, reinício —, e decidiu que o
 * atendimento faz isso. O que continua garantindo que o cliente saiba quem foi
 * é a trilha: toda escrita de uma personificação entra no `audit_log` do
 * provedor com `actorKind: 'platform'` e o usuário da plataforma.
 */
const IMPERSONATION_ROLE = 'admin';

function generateImpersonationToken(platformUser, tenantId) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('generateImpersonationToken needs the provider being impersonated');
  }
  return jwt.sign(
    {
      userId: platformUser.id,
      username: platformUser.username,
      tenantId: id,
      role: IMPERSONATION_ROLE,
      impersonation: true,
      tokenVersion: Number(platformUser.token_version || 0)
    },
    JWT_SECRET,
    {
      issuer: 'skygenpanel',
      audience: PLATFORM_AUDIENCE,
      expiresIn: IMPERSONATION_EXPIRES_IN
    }
  );
}

/**
 * O par de tokens do console: a sessão que NÃO pertence a provedor nenhum.
 *
 * Sem `tenantId` e sem `role`, e a ausência é estrutural em vez de uma
 * bandeira: não existe valor para alguém ler errado. Uma rota que tente usar
 * esta sessão como se fosse de painel não encontra provedor para escopar —
 * `authenticateToken` a roda em `runUnscoped`, e ali toda leitura escopada
 * estoura em vez de servir o provedor de menor id.
 *
 * O que ela carrega de autoridade é NADA: `platform: true` é a forma da
 * sessão, não a permissão. Quem tem a chave do console é lido fresco de
 * `platform_admins` na hidratação e outra vez em `requirePlatformAdmin`, a cada
 * requisição — pelo motivo que este arquivo já escreveu: uma concessão retirada
 * às 09:00 tem que parar de valer às 09:00, e não quando o token vencer.
 *
 * COM refresh, ao contrário da personificação. A diferença não é de rigor, é do
 * que cada uma é: personificar é um atendimento de meia hora, e o incômodo de
 * refazê-lo é o mecanismo; o console é onde alguém passa a tarde revisando
 * provedores e faturamento, e expulsá-lo de hora em hora não protege nada — a
 * alternativa, um token de acesso longo, é que seria pior.
 */
function generateConsoleTokens(user) {
  const commonOptions = {
    issuer: 'skygenpanel',
    audience: CONSOLE_AUDIENCE
  };
  const accessToken = jwt.sign(
    {
      userId: user.id,
      username: user.username,
      platform: true,
      tokenVersion: Number(user.token_version || 0)
    },
    JWT_SECRET,
    { ...commonOptions, expiresIn: JWT_EXPIRES_IN }
  );

  const refreshToken = jwt.sign(
    {
      userId: user.id,
      platform: true,
      tokenType: 'refresh',
      tokenVersion: Number(user.token_version || 0)
    },
    JWT_SECRET,
    { ...commonOptions, expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );

  return { accessToken, refreshToken };
}

/**
 * The membership a token stands for, or null.
 *
 * Two rules, and the second is the transition.
 *
 * When the token names a provider, the membership is read back from the table
 * on every request rather than believed from the token. The claims record what
 * the person's access was when they signed in; access withdrawn since has to
 * stop working before the hour the token is good for runs out, and a token
 * naming a provider the person no longer works for has to answer the same way
 * as a token naming one they never worked for. The role comes from the row for
 * the same reason — a demotion applies at the next request, not at the next
 * sign-in — which leaves the role in the token as a record of what it was, and
 * the row as the thing that decides.
 *
 * A token minted before this change carries no `tenantId` at all. It keeps
 * working, resolved through the person's sole membership — dropping every open
 * session on an upgrade would put the whole night shift back at the login
 * screen for nothing. With more than one membership and no `tenantId` there is
 * no honest answer, so it refuses: picking one would mean handing somebody
 * another ISP's fleet on a coin toss, and the person can simply sign in again
 * to say which provider they mean.
 */
async function resolveMembership(userId, tenantId) {
  if (tenantId === undefined || tenantId === null) {
    const memberships = await TenantUser.listForUser(userId);
    return memberships.length === 1
      ? openMembership(userId, memberships[0].tenant_id)
      : null;
  }
  return openMembership(userId, tenantId);
}

/**
 * Se o provedor recebe esta pessoa: ativo, ou ela opera a plataforma.
 *
 * Suspender um provedor é trancá-lo. O resolvedor responde 404 no host dele,
 * mas num deploy de host único — ou com o slug ainda em cache noutra réplica —
 * o escopo vem do token, e sem esta conferência os operadores do provedor
 * suspenso continuavam entrando, renovando a sessão e trabalhando lá dentro. A
 * exclusão em duas etapas confia na suspensão para querer dizer "ninguém está
 * trabalhando ali".
 *
 * Quem opera a plataforma passa: num deploy de host único o console é servido
 * pela sessão de painel dele, e trancá-lo junto com o provedor tiraria de quem
 * suspendeu a única rota para reativar ou concluir a exclusão.
 */
async function tenantOpenFor(userId, status) {
  if (status === 'active') return true;
  return PlatformAdmin.has(userId);
}

/** O vínculo de uma pessoa com um provedor, se o provedor a recebe. */
async function openMembership(userId, tenantId) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const membership = await TenantUser.findWithStatus(id, userId);
  if (!membership || !(await tenantOpenFor(userId, membership.tenant_status))) return null;
  return membership;
}

/**
 * O vínculo com a exigência de 2FA do provedor ao lado, para a sessão.
 *
 * Com o provedor nomeado no token — todo token cunhado hoje —, é uma consulta
 * só, a mesma que já se fazia, com um `join`. O token antigo sem provedor paga
 * uma segunda, e só ele.
 */
async function resolveSessionMembership(userId, tenantId) {
  if (tenantId === undefined || tenantId === null) {
    const unico = await resolveMembership(userId, tenantId);
    return unico ? TenantUser.findWithPolicy(unico.tenant_id, userId) : null;
  }
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const membership = await TenantUser.findWithPolicy(id, userId);
  if (!membership || !(await tenantOpenFor(userId, membership.tenant_status))) return null;
  return membership;
}

/**
 * Who is asking and where they are asking from, or null for "not a session".
 *
 * Every refusal collapses to the same null on purpose: an expired revocation,
 * a deleted person and a membership that ended are three different facts, and
 * the caller holding a token has no business learning which of them applies.
 */
async function hydrateAuthenticatedUser(decoded) {
  if (!decoded || decoded.tokenType || !Number.isInteger(Number(decoded.userId))) {
    return null;
  }
  // Cada audiência tem uma forma válida e só uma, e a conferência é exaustiva:
  // uma audiência que este `switch` não conheça não vira sessão. Era um par de
  // `if`s enquanto havia duas audiências; com três, um encadeado deixaria a
  // quarta passar no dia em que alguém a acrescentasse sem mexer aqui.
  //
  // As formas cruzadas são o que isto barra: um token de plataforma sem a marca
  // de personificação seria uma sessão comum entrando por uma porta que não
  // confere membership; um de painel COM a marca seria uma personificação
  // entrando por uma que não confere o cadastro da plataforma; e um de console
  // que trouxesse `tenantId` seria uma sessão sem provedor pedindo para ser
  // escopada em um.
  const forma = (() => {
    switch (decoded.aud) {
      case PANEL_AUDIENCE:
        return decoded.impersonation || decoded.platform ? null : 'painel';
      case PLATFORM_AUDIENCE:
        return decoded.impersonation === true && !decoded.platform ? 'personificacao' : null;
      case CONSOLE_AUDIENCE:
        return decoded.platform === true && !decoded.impersonation && decoded.tenantId === undefined
          ? 'console'
          : null;
      default:
        return null;
    }
  })();
  if (!forma) return null;

  const user = await User.findById(decoded.userId);
  if (!user || Number(user.token_version || 0) !== Number(decoded.tokenVersion || 0)) {
    return null;
  }

  if (forma === 'personificacao') return hydrateImpersonation(user, decoded);
  if (forma === 'console') return hydrateConsole(user);

  const membership = await resolveSessionMembership(user.id, decoded.tenantId);
  if (!membership) return null;

  return {
    userId: user.id,
    username: user.username,
    role: membership.role,
    tenantId: Number(membership.tenant_id),
    tokenVersion: Number(user.token_version || 0),
    // O provedor exige o 2FA e esta pessoa ainda não ativou. Lido a cada
    // requisição, e não gravado no token: o dono liga a exigência e quem já
    // estava dentro é parado na próxima chamada, não quando o token vencer.
    mfaEnrollmentRequired: mfaRequired(membership) && !user.totp_enabled_at
  };
}

/**
 * O que quem precisa ativar o 2FA ainda alcança: a própria conta — ver quem é,
 * ativar, sair, renovar a sessão — e o nome do provedor na tela.
 *
 * Tudo em `/api/auth/` e não uma lista de rotas dali: são as rotas da conta da
 * pessoa, nenhuma lê nem escreve dado do provedor, e uma lista fina quebraria
 * em silêncio no dia em que a tela de ativação precisasse de mais uma delas.
 */
const MFA_ENROLLMENT_PREFIXES = ['/api/auth/'];
const MFA_ENROLLMENT_PATHS = new Set(['/api/auth', '/api/tenant/public']);

/**
 * O caminho como o ROTEADOR o enxerga, para as guardas que decidem por ele.
 *
 * O Express casa rota sem distinguir caixa (`caseSensitive` desligado, o
 * padrão): `POST /API/Auth/logout` chega ao mesmo handler que
 * `/api/auth/logout`. Uma guarda que compara o caminho cru ao pé da letra vê
 * outra coisa que o roteador, e a diferença é um desvio — a personificação
 * escrevia na conta de quem personifica só trocando a caixa. Minúsculas aqui
 * fazem a guarda e o roteador concordarem; a query fica de fora porque não
 * escolhe rota.
 */
function routedPath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0].toLowerCase();
}

function mfaEnrollmentRefusal(req, session) {
  if (!session.mfaEnrollmentRequired) return null;
  // Aqui a leitura crua falhava FECHADA (caixa trocada caía fora da lista e era
  // recusada), mas o certo é a mesma leitura do roteador: `/API/Auth/mfa/setup`
  // É a rota de ativação, e recusá-la só por caixa não protege nada.
  const path = routedPath(req);
  if (MFA_ENROLLMENT_PATHS.has(path)) return null;
  if (MFA_ENROLLMENT_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;
  return {
    success: false,
    code: 'mfa_enrollment_required',
    message: req.t('auth.mfaEnrollmentRequired')
  };
}

/**
 * A sessão do console, montada agora e não acreditada do token.
 *
 * Duas leituras frescas, e as duas por requisição:
 *
 * - **o cadastro da plataforma**, que é a única autoridade desta sessão. Isto é
 *   redundante com `requirePlatformAdmin`, e a redundância é de propósito:
 *   `/api/auth/user` não está atrás daquela guarda, e sem esta leitura a sessão
 *   continuaria se apresentando como válida a quem já foi tirado do cadastro.
 * - **a chave `LOGIN_REQUIRES_EMAIL`**, pelo mesmo motivo que o refresh a lê:
 *   um interruptor que só um dos caminhos de sessão obedece não é interruptor.
 *
 * `tenantId: null` e `role: null` explícitos. Não é descuido: é a resposta
 * honesta de uma sessão que não trabalha em provedor nenhum, e é o que faz
 * `requirePermission` recusá-la em vez de consultar a matriz com um papel
 * inventado.
 */
async function hydrateConsole(user) {
  if (!(await PlatformAdmin.has(user.id))) return null;
  if (!canHoldSession(user)) return null;

  return {
    userId: user.id,
    username: user.username,
    role: null,
    tenantId: null,
    platform: true,
    tokenVersion: Number(user.token_version || 0)
  };
}

/**
 * A sessão de quem está olhando o painel de um cliente.
 *
 * Não lê `tenant_users`, e não poderia: quem personifica não trabalha para o
 * provedor: é justamente por não ter vínculo lá que a personificação existe. O
 * que substitui a membership como autoridade são duas leituras frescas, a cada
 * requisição, pelo mesmo motivo que a membership é lida fresca:
 *
 * - **o cadastro da plataforma**, porque tirar alguém de lá tem que encerrar o
 *   que ela está olhando na requisição seguinte, e não quando o token vencer;
 * - **a linha do provedor**, porque um provedor apagado no meio de um
 *   atendimento não pode continuar sendo lido por um token que o nomeia.
 *
 * E o papel é imposto aqui, `IMPERSONATION_ROLE`, sem olhar o token. Ver `impersonationRefusal`
 * logo abaixo para o segundo muro.
 */
async function hydrateImpersonation(user, decoded) {
  const tenantId = Number(decoded.tenantId);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return null;
  if (!(await PlatformAdmin.has(user.id))) return null;
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) return null;

  return {
    userId: user.id,
    username: user.username,
    role: IMPERSONATION_ROLE,
    tenantId,
    tokenVersion: Number(user.token_version || 0),
    // O que a tela mostra na faixa, o que a trilha nomeia, e o que as guardas
    // consultam. Presente só numa personificação: `req.user.impersonation` ser
    // falsy é a definição de "sessão comum" em todo o resto do código.
    //
    // O nome do provedor vem DAQUI e não do perfil público, que é resolvido
    // pelo host: numa instalação de host único o host nomeia sempre o primeiro
    // provedor, e a faixa diria "você está olhando o painel de X" enquanto a
    // sessão está em Y. Uma faixa que existe para dizer em qual painel se está
    // errar o nome é pior do que não dizer. A linha do provedor já está lida
    // aqui logo acima — era só não jogá-la fora.
    impersonation: {
      platformUsername: user.username,
      tenantName: tenant.name,
      tenantSlug: tenant.slug
    }
  };
}

/**
 * Puts the request in the provider its token names, then lets it through.
 *
 * `resolveTenant` runs first, as `app.use('/api', …)`, and opens the
 * installation's own provider so that everything reachable WITHOUT a session —
 * login, setup, refresh — has a scope to work in. That scope is provisional.
 * The moment a token has been verified against the table we know which provider
 * this request is actually for, and re-entering `runInTenant` around `next()`
 * replaces it for the whole rest of the chain: the route's own middleware, the
 * controller, the models, and every asynchronous continuation underneath them,
 * since that is what an AsyncLocalStorage scope covers.
 *
 * Doing it here rather than in `resolveTenant` is the point. The resolver sees
 * only what the caller sent; this runs after the membership has been read back
 * from `tenant_users`, so the scope a request runs in is one the person
 * demonstrably still holds, not one they claimed.
 *
 * What that leaves: a future route mounted under `/api` that reads scoped data
 * WITHOUT `authenticateToken` would silently read the installation's own
 * provider. Every panel route today requires it — the exceptions (health, the
 * Evolution webhook, the signed media fetch) either run before the resolver or
 * open their own scope explicitly.
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: req.t('auth.tokenRequired') });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({
      message: req.t('auth.invalidToken'),
      code: 'invalid_token'
    });
  }

  if (decoded.tokenType) {
    return res.status(403).json({
      message: req.t('auth.invalidTokenType'),
      code: 'invalid_token'
    });
  }

  let session;
  try {
    session = await hydrateAuthenticatedUser(decoded);
  } catch (error) {
    return next(error);
  }

  if (!session) {
    return res.status(403).json({
      message: req.t('auth.sessionInvalid'),
      code: 'invalid_token'
    });
  }

  if (!tokenMatchesHost(req, session)) {
    return res.status(403).json({
      message: req.t('auth.sessionInvalid'),
      code: 'tenant_mismatch'
    });
  }

  const readOnly = impersonationRefusal(req, session);
  if (readOnly) return res.status(403).json(readOnly);

  const semSegundoFator = mfaEnrollmentRefusal(req, session);
  if (semSegundoFator) return res.status(403).json(semSegundoFator);

  req.user = session;
  req.tenantId = session.tenantId;

  // A sessão do console não entra em provedor nenhum, e é isso que a faz
  // segura: `runUnscoped` deixa o contexto ABERTO e declarado, então uma rota
  // do console que esqueça o `runInTenant` estoura alto — hoje ela escreveria
  // em silêncio no provedor de quem operou o console. O portão da assinatura
  // fica fora por construção: a plataforma não assina nada, e
  // `SubscriptionService` lê por `tdb`.
  if (session.platform) {
    return runUnscoped('platform console session', () => next(), { actor: session });
  }
  // O autor entra no escopo junto com o provedor. Sem ele, uma escrita fundo
  // num serviço não tem como dizer quem a provocou nem como saber que está
  // dentro de uma personificação — e as duas coisas fazem falta em
  // `CustomerService`, que aposenta conta de assinante e apaga vínculo de ERP a
  // partir de um GET.
  return runInTenant(session.tenantId, async () => {
    // A porta da assinatura mora AQUI, e não num `app.use` acima das rotas,
    // para que o 401 venha sempre antes do 402. No lugar antigo um request sem
    // token nenhum respondia diferente conforme a fatura do provedor, e a
    // inadimplência de um ISP virava fato consultável por qualquer um que
    // alcançasse o host. Ver o topo de `subscriptionGate.js`.
    let recusa;
    try {
      recusa = await subscriptionRefusal(req);
    } catch (error) {
      return next(error);
    }
    if (recusa) return res.status(402).json(recusa);
    return next();
  }, { actor: session });
}

/**
 * Whether a token may be used on the host it arrived at.
 *
 * Três casos, e a ordem entre eles é a regra:
 *
 * 1. **No host da própria plataforma**, só uma sessão da plataforma serve. O
 *    ápice não pertence a provedor nenhum, então `req.hostTenantId` é nulo ali
 *    e `hostMatchesTenant` diria "não há com o que discordar" — verdade
 *    enquanto o ápice servia duas rotas anônimas, e um replay no minuto em que
 *    ele passa a servir rota autenticada: o escopo viria do token e o painel de
 *    um provedor seria servido pelo endereço da plataforma. Esta linha entra
 *    ANTES de existir sessão de plataforma alguma, de propósito: hoje ela
 *    recusa todo token no ápice, que é exatamente o que se quer até o console
 *    ter sessão própria.
 * 2. **Uma sessão da plataforma fora do ápice** não serve. Ela não nomeia
 *    provedor, então não há escopo em que ela possa ler nada num host de
 *    provedor; recusar aqui é dizer isso uma vez, em vez de deixar cada leitura
 *    escopada descobrir sozinha.
 * 3. **O resto** é a regra compartilhada de `hostMatchesTenant`: o host só
 *    discorda de uma credencial onde ele NOMEOU um provedor.
 *
 * Sem o caso 3, um token cunhado em `alfa.painel.exemplo.com` funcionaria
 * contra `beta.painel.exemplo.com`: o escopo viria do token, então o operador
 * não VERIA o dado do beta — mas a requisição seria servida, e todo rate limit,
 * linha de trilha e mensagem de erro ficaria atribuída a um provedor que quem
 * chamou não tem por que nomear.
 */
function tokenMatchesHost(req, session) {
  if (req.platformHost) return Boolean(session.platform);
  // Sessão de console fora do endereço da plataforma: recusada onde esse
  // endereço EXISTE. Num deploy sem domínio-base não existe host de plataforma
  // nenhum — o console divide o único endereço com os painéis, exatamente como
  // `platformHostOnly` já reconhece ao virar no-op ali. As duas guardas leem a
  // mesma função para não poderem discordar.
  if (session.platform) return !usesTenantSubdomains();
  return hostMatchesTenant(req, session.tenantId);
}

/** Os métodos que não mudam nada. Tudo que não está aqui é escrita. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * O que uma sessão de atendimento NÃO escreve, ou null.
 *
 * Personificar era só olhar, e este muro recusava toda escrita. A plataforma
 * passou a atender mexendo no painel do cliente — com o papel `admin` e cada
 * escrita assinada na trilha do provedor como `actorKind: 'platform'` —, então
 * o muro encolheu para o que nunca é do provedor: as rotas da conta.
 *
 * O `POST /api/auth/logout` é o caso que mostra por quê: ele incrementa o
 * `token_version` da pessoa, e a pessoa aqui é quem personifica. Sem esta
 * recusa, "sair" de uma personificação derrubaria as sessões dessa pessoa em
 * todo o deploy.
 */
function impersonationRefusal(req, session) {
  if (!session.impersonation) return null;
  if (READ_METHODS.has(req.method)) return null;
  // Só as rotas da CONTA ficam de fora. Nelas "quem" é a pessoa que
  // personifica, não o provedor: sair incrementaria o `token_version` dela e
  // derrubaria as sessões dela em todo o deploy; trocar senha ou segundo fator
  // mexeria na conta da plataforma a partir do painel de um cliente.
  // `routedPath` e não o caminho cru: o roteador ignora caixa, e com a
  // comparação literal `POST /API/Auth/logout` atravessava este muro.
  if (!routedPath(req).startsWith('/api/auth/')) return null;
  return {
    success: false,
    message: req.t('auth.impersonationReadOnly'),
    code: 'impersonation_read_only'
  };
}

/**
 * Aqui morava `authenticateTokenOptional` — a forma "sessão se houver", para a
 * rota que enriquece a resposta de quem está logado e ainda serve quem não
 * está.
 *
 * Removida sem substituto porque ela NUNCA foi usada: rota nenhuma a importava,
 * e o que ela era de fato é uma armadilha com cara de coisa revisada. Faltavam
 * nela os três muros que a forma obrigatória aplica logo acima — a recusa de
 * escrita numa personificação, a recusa por assinatura, e o ator no escopo do
 * provedor. A primeira rota que a adotasse nasceria servindo provedor
 * inadimplente e aceitando escrita dentro de um atendimento, sem que ninguém
 * tivesse decidido isso.
 *
 * Quem precisar dela um dia escreve a versão com os muros, que é o trabalho que
 * a existência dela escondia.
 */

/**
 * A guarda de rota, dita pelo que a rota FAZ.
 *
 * Substitui `requireRole(['admin'])` nas 91 rotas do painel. A diferença não é
 * de estilo: com o papel escrito na rota, a política mora em 91 arquivos e
 * acrescentar um papel obriga a reabrir os 91 e decidir de novo, um a um — e o
 * esquecimento não aparece, a rota apenas continua exigindo `admin`. Com a
 * capacidade escrita na rota, a política inteira é a matriz de
 * `config/permissions.js`, que é uma coisa só para revisar.
 *
 * 403 e não 404 aqui, ao contrário do resto do painel: quem chegou até esta
 * guarda passou por `authenticateToken`, tem sessão válida NESTE provedor, e o
 * que falta é atribuição. "Você não pode isto" não conta a essa pessoa nada que
 * ela já não saiba — ela sabe que a tela existe, é colega de quem a usa. O 404
 * existe para não confirmar a EXISTÊNCIA de um registro a quem não deveria
 * saber dele; não é o caso de uma rota fixa do produto.
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: req.t('auth.required') });
    }
    // A sessão do console não tem provedor, então não tem papel, então não tem
    // o que consultar nesta matriz: ela responde "o que esta pessoa pode no
    // provedor DELA". Recusa explícita e não confiança em `roleHas(null, …)`
    // devolver false — depender disso é depender de a matriz nunca tratar a
    // ausência como permissiva. O console age pelas rotas dele, atrás de
    // `requirePlatformAdmin`, que é outra pergunta.
    if (req.user.platform) {
      return res.status(403).json({
        message: req.t('auth.insufficientPermissions'),
        code: 'missing_permission'
      });
    }
    if (!roleHas(req.user.role, permission)) {
      return res.status(403).json({
        message: req.t('auth.insufficientPermissions'),
        code: 'missing_permission'
      });
    }
    return next();
  };
}

/**
 * Lets through only the people who hold the control plane.
 *
 * Runs after `authenticateToken`, so `req.user` is a session that has already
 * been checked against the tables. What this adds is a different KIND of
 * authority: `requirePermission` asks what somebody may do at the provider their token
 * names, and the answer is never "may create providers" — an administrator at
 * an ISP administers that ISP. Being admin at a provider must not reach the
 * control plane, which is the whole point of a second roster.
 *
 * The roster is read from `platform_admins` on EVERY request, exactly as wave
 * 12 re-reads the membership. The token is a claim about who signed in; it is
 * never the authority. A grant withdrawn at 09:00 has to stop working at 09:00
 * and not whenever the hour the token is good for happens to run out — and at
 * this level, where the withdrawn grant may be the reason somebody was taken
 * off it, waiting out an expiry is not a compromise worth making. There is no
 * platform claim in the token for the same reason: a claim nobody trusts is
 * one somebody eventually trusts by mistake.
 *
 * A caller who is not on the roster is answered 404, not 403, in the exact body
 * `app.js` gives an unrouted `/api` path. The contract froze that reasoning one
 * level up: the platform routes are mounted under `IS_SAAS`, and on a
 * self-hosted install they do not answer 403 — they do not exist, because a 403
 * tells whoever asked that the control plane is there. The same sentence
 * decides this one. A 403 here would tell a provider's own administrator that
 * the control plane exists on this deployment and that they are merely not on
 * it, which is exactly the fact worth not confirming: it turns a shrug into a
 * target and names the shape of account worth phishing for. With a 404, their
 * token cannot tell a hosted deployment's control plane from a self-hosted
 * install's not having one. It is also the answer wave 12 already settled on
 * for the neighbouring question — an id with no membership at this provider is
 * answered as nonexistent, never as forbidden.
 *
 * What this does NOT hide, and cannot: `authenticateToken` runs first, so an
 * anonymous request to a mounted platform route still answers 401 where an
 * unrouted path answers 404. Closing that is the mounting's business — the
 * lanes that build these routes decide it — not the guard's.
 */
async function requirePlatformAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: req.t('auth.required') });
  }

  // Uma personificação NÃO alcança o console, mesmo sendo de quem o alcança.
  //
  // Quem personifica está no cadastro da plataforma — a hidratação acabou de
  // conferir isso —, então a checagem abaixo passaria. O que não pode passar é
  // a requisição: ela foi re-escopada no provedor personificado, e uma rota do
  // console rodando ali agiria sobre o cliente errado, com uma sessão que
  // existe para olhar. A saída é a que já existia: voltar ao console com o
  // token de lá, que é outro token, na outra audiência.
  //
  // 404 e não 403 pelo mesmo motivo do resto desta guarda: quem chegou aqui
  // não aprende se o plano de controle existe.
  if (req.user.impersonation) {
    return res.status(404).json({
      success: false,
      message: req.t('common.routeNotFound')
    });
  }

  let holdsIt;
  try {
    holdsIt = await PlatformAdmin.has(req.user.userId);
  } catch (error) {
    return next(error);
  }

  if (!holdsIt) {
    return res.status(404).json({
      success: false,
      message: req.t('common.routeNotFound')
    });
  }

  return next();
}

export {
  generateTokens,
  generateImpersonationToken,
  generateConsoleTokens,
  CONSOLE_AUDIENCE,
  verifyToken,
  resolveMembership,
  openMembership,
  authenticateToken,
  requirePermission,
  requirePlatformAdmin
};

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { testConnection } from './config/database.js';
import { IS_SAAS, IS_SELF_HOSTED } from './config/edition.js';
import { TRUST_PROXY } from './config/proxy.js';
import { attachLocale } from './middleware/locale.js';
import { isPlatformHost, platformHostOnly, resolveTenant } from './middleware/tenantResolver.js';
import { robotsFor, sitemapFor } from './services/seoFiles.js';
import { DEFAULT_LOCALE, translate, translateError } from './i18n/index.js';
import {
  apiLimiter,
  attachmentUploadLimiter,
  authLimiter,
  firmwareUploadLimiter,
  portalIpLimiter,
  portalLoginLimiter
} from './middleware/rateLimit.js';
import { authenticateToken, requirePermission, requirePlatformAdmin } from './middleware/auth.js';
import { log, requestLogger } from './utils/logger.js';
import { httpMetrics } from './utils/metrics.js';
import { acsAgentOfflineBody, isAgentOffline } from './services/genieacs/agent.js';

import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import customerRoutes from './routes/customers.js';
import settingsRoutes from './routes/settings.js';
import vendorRoutes from './routes/vendors.js';
import mappingRoutes from './routes/mapping.js';
import mapSettingsRoutes from './routes/mapSettings.js';
import databaseRoutes from './routes/database.js';
import platformRoutes from './routes/platform.js';
import platformMemberRoutes from './routes/platformMembers.js';
import platformAdminRoutes from './routes/platformAdmins.js';
import platformBillingRoutes from './routes/platformBilling.js';
import platformLeadsRoutes from './routes/platformLeads.js';
import platformReportsRoutes from './routes/platformReports.js';
import publicRoutes from './routes/public.js';
import platformIntegrationsRoutes from './routes/platformIntegrations.js';
import userRoutes from './routes/users.js';
import inviteRoutes from './routes/invites.js';
import auditRoutes from './routes/audit.js';
import tenantRoutes from './routes/tenant.js';
import customerPortalRoutes from './routes/customerPortal.js';
import sgpRoutes from './routes/sgp.js';
import teiahRoutes from './routes/teiah.js';
import focusChatRoutes from './routes/focuschat.js';
import contactRoutes from './routes/contacts.js';
import whatsappRoutes from './routes/whatsapp.js';
import whatsappMessageRoutes from './routes/whatsappMessages.js';
import whatsappAlertRoutes from './routes/whatsappAlerts.js';
import whatsappBillingRoutes from './routes/whatsappBilling.js';
import whatsappWebhookRoutes from './routes/whatsappWebhook.js';
import billingWebhookRoutes from './routes/billingWebhook.js';
import { BILLING_WEBHOOK_PATH } from './config/billingWebhookPath.js';
import { WA_WEBHOOK_PATH } from './config/waWebhookPath.js';
import whatsappMediaRoutes from './routes/whatsappMedia.js';
import { ATTACHMENT_PATH, attachmentRawBody } from './services/waAttachmentService.js';
import { FIRMWARE_REASSIGN_PATH, FIRMWARE_UPLOAD_PATH, firmwareRawBody } from './services/firmwareStore.js';
import provisioningRoutes from './routes/provisioning.js';
import genieacsAgentFileRoutes from './routes/genieacsAgentFiles.js';
import { WEBHOOK_PATH } from './services/sgpService.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();
export const portalApp = express();

export const APP_ENV = process.env.APP_ENV || 'development';
export const FRONTEND_DIR = process.env.FRONTEND_DIR
  || path.join(__dirname, '..', '..', 'frontend', 'dist');
export const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
).version;

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5890')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const helmetOptions = {
  // COOP is ignored on plain HTTP public-IP deployments and OAC can produce
  // persistent browser warnings when an origin previously used site-keying.
  // TR69 Controle does not rely on cross-origin isolation, so omit both headers.
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin'
  },
  contentSecurityPolicy: {
    directives: {
      // Vite emits external hashed modules, so inline scripts remain blocked.
      scriptSrc: ["'self'"],
      // The built-in server defaults to HTTP; upgrading relative assets would
      // make browsers request HTTPS from a port that has no TLS listener.
      upgradeInsecureRequests: null,
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://tile.openstreetmap.org',
        'https://mt1.google.com'
      ],
      // Áudio do WhatsApp: o arquivo chega com o token no cabeçalho e vira um
      // blob em memória, que é o que o `<audio>` toca (e a prévia da gravação).
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  }
};

/**
 * O painel usa o microfone (gravar áudio no WhatsApp), e só ele, só na
 * própria origem. O portal do assinante não tem por que pedir.
 */
const PANEL_PERMISSIONS = 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()';
const PORTAL_PERMISSIONS = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()';

function configureSecurity(target, permissions) {
  target.disable('x-powered-by');
  if (TRUST_PROXY !== null) {
    target.set('trust proxy', TRUST_PROXY);
  }
  target.use(helmet(helmetOptions));
  target.use((req, res, next) => {
    res.setHeader('Permissions-Policy', permissions);
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });
}

configureSecurity(app, PANEL_PERMISSIONS);
configureSecurity(portalApp, PORTAL_PERMISSIONS);

function isAllowedOrigin(req, origin) {
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;

  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

app.use(attachLocale);

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (!isAllowedOrigin(req, origin)) {
    return res.status(403).json({
      success: false,
      message: req.t('common.originNotAllowed')
    });
  }
  return next();
});

app.use(cors({
  origin: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Sem isto o navegador esconde o cabeçalho de quem é servido de outra origem,
  // e esconde em silêncio: o download acontece, com o nome errado. É o único
  // cabeçalho que o painel precisa LER de uma resposta, e ele existe para que o
  // servidor continue sendo o único autor do nome do arquivo exportado —
  // remontar a regra no frontend seria a segunda cópia, e a segunda diverge.
  exposedHeaders: ['Content-Disposition']
}));
// The webhook signature covers the exact bytes SGP signed, so this route has
// to see the raw body. Mounting `express.raw` on the path before the global
// JSON parser is what reserves it: body-parser marks the body as read, so the
// parser below skips it. A `verify` hook on the global parser would instead
// copy every request body in the process.
app.use(WEBHOOK_PATH, express.raw({ type: '*/*', limit: '64kb' }));
// The operator's attachment upload, reserved here for the same reason and in
// the same way: its body is the file itself, and the global parser below is
// sized for JSON — a 12 MB photo posted past this line would fail as a parse
// error against a 1 MB ceiling rather than as anything the screen could
// explain. The route itself exige `whatsapp.send` e vive com as outras rotas de
// WhatsApp; só o parser do corpo precisa estar tão cedo.
//
// What has to come with it is everything that decides whether these 16 MB are
// worth holding at all. `apiLimiter` and `authenticateToken` are both mounted
// further down, so until now an anonymous caller could make the panel buffer a
// 16 MB body and only THEN be told to log in — nothing before this line refuses
// anything, since `cors({ origin: true })` admits a request that sends no
// Origin at all. The limiter and the session check are repeated on the route
// itself; repeating them costs one extra read of a shared table per upload,
// which is nothing against holding 16 MB per anonymous request.
//
// They stay on this path only, rather than being hoisted with `apiLimiter`:
// the Evolution webhook and the signed media route are mounted below on purpose
// and must keep their own, much higher, buckets.
//
// `attachLocale` is already above, so `req.t` exists for both refusals, and
// `authenticateToken` reads only the `Authorization` header — it needs neither
// the parsed body nor `resolveTenant`, which is why it can run this early.
app.use(
  ATTACHMENT_PATH,
  attachmentUploadLimiter,
  authenticateToken,
  // A MESMA capacidade que a rota de upload em `whatsappMessages.js` exige.
  // As duas guardam o mesmo caminho e têm que concordar: mais frouxa aqui
  // deixaria alguém sem a capacidade gastar a banda e o disco do parser antes
  // de tomar 403 da rota; mais apertada faria a rota responder 403 a quem pode,
  // sem que nada perto dela dissesse por quê.
  requirePermission('whatsapp.send'),
  attachmentRawBody
);
// O firmware enviado ao GenieACS: o corpo é o arquivo (até `FIRMWARE_MAX_MB`),
// reservado aqui pelo mesmo motivo e na mesma ordem do anexo acima — limite,
// sessão e capacidade ANTES de o parser guardar um byte. Só o `POST` e só o
// caminho exato (`app.post`, e não `app.use`): a lista (`GET`) e o apagar
// (`DELETE .../:name`) do mesmo prefixo não têm corpo, e não devem gastar o
// balde do envio. As rotas em si vivem com as vizinhas (`routes/devices.js`,
// `routes/platform.js`), que repetem as guardas.
app.post(
  FIRMWARE_UPLOAD_PATH,
  firmwareUploadLimiter,
  authenticateToken,
  // A MESMA capacidade da rota em `routes/devices.js`.
  requirePermission('devices.maintain'),
  firmwareRawBody
);
// O reenvio da plataforma de um firmware sem dono (console → GenieACS do
// provedor). Guarda do console em vez da capacidade de provedor.
app.post(
  FIRMWARE_REASSIGN_PATH,
  firmwareUploadLimiter,
  authenticateToken,
  requirePlatformAdmin,
  firmwareRawBody
);
app.use(express.json({ limit: '1mb' }));

// Mounted BEFORE the shared `apiLimiter` on purpose. The Evolution server is a
// server, not a browser session: it authenticates with the token in its own
// query string, so this route stays outside `authenticateToken`, and its normal
// burst — a QR rotation every 20 s, one receipt per recipient per delivery
// state — would trip a 300/min bucket sized for a human clicking around. It
// declares its own, much higher, ceiling instead.
// O caminho vem da constante e não de um literal aqui: `whatsappConfigService`
// confere contra ele o endereço público que o operador digita, e as duas
// pontas divergirem é justamente a falha que essa conferência existe para
// impedir.
app.use(WA_WEBHOOK_PATH, whatsappWebhookRoutes);

// Mesma razão, mesmo lugar na pilha, e mais uma que é só desta: a entrega do
// gateway de pagamento chega no endereço que a plataforma digitou no painel
// DELE — o apex, na prática —, e o apex não nomeia provedor nenhum. Resolvida
// por host ela levaria 404 antes de chegar ao controlador, e o pagamento de um
// cliente ficaria na fila de reentrega do gateway até alguém reparar.
//
// Nada de provedor entra em escopo aqui, então qualquer consulta escopada que
// o caminho alcançasse falharia com a sentinela — que é a guarda que se quer.
// O provedor sai do CORPO, e o `runInTenant` do controlador é o que credita.
app.use(BILLING_WEBHOOK_PATH, billingWebhookRoutes);

// Same reasoning, same place in the stack: the Evolution server fetches a
// media file to send it, carrying a signed, short-lived token in its own query
// string rather than a session. It is mounted before `apiLimiter` because a
// campaign with attachments would otherwise spend a bucket sized for a human
// clicking around; the route declares its own ceiling.
app.use('/api/whatsapp-media', whatsappMediaRoutes);

app.use('/api', apiLimiter);

// Health answers before a provider is resolved, deliberately. It reports
// whether the database is reachable, and resolving the provider is itself a
// database read — behind the resolver, an unreachable database would answer a
// blank 500 instead of naming the thing that is down.
app.get('/api/health', async (req, res) => {
  const database = await testConnection();
  res.status(database ? 200 : 503).json({
    status: database ? 'ok' : 'degraded',
    database: database ? 'ok' : 'unavailable',
    timestamp: new Date().toISOString(),
    version: APP_VERSION
  });
});

// Uma linha por requisição e um contador por provedor, ANTES do resolvedor:
// uma requisição recusada por não nomear provedor também é um evento, e é
// justamente o que se quer ver quando um DNS está errado.
app.use('/api', requestLogger());
app.use('/api', httpMetrics());
app.use('/api', resolveTenant);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/refresh', authLimiter);
app.use('/api/auth/setup', authLimiter);
app.use('/api/auth/signup', authLimiter);

// Below `resolveTenant`, which is what makes this route safe to leave open.
// It answers with a provider's name to anybody who asks, so the question of
// WHICH provider must never be the caller's to decide: the resolver has
// already read it off the `Host` header by the time this line runs, and an
// unknown or inactive host was refused up there with a 404 that says nothing
// about which of the two it was. Mounted above it, this would become a route
// that reads out the first row of `tenants` to the internet.
//
// No limiter of its own: `apiLimiter` above already covers everything under
// `/api`, and the enumeration a tighter bucket here would be aimed at is
// visible on every other path under `/api` too, so it is not this route's to
// fix. The reasoning is in `tenantController.js`.
app.use('/api/tenant', tenantRoutes);

// O instalador e o programa do agente do GenieACS, públicos e sem segredo.
// Abaixo do resolvedor por um motivo só: o instalador sai com a origem do
// painel como padrão de PANEL_URL, e essa origem é a do provedor que o
// resolvedor já conferiu no banco — nunca o `Host` cru. No ápice os dois
// caminhos estão em `PLATFORM_HOST_PATHS`, porque é de lá que o console mostra o
// comando de instalação. A conexão do agente em si (`/connect`) não passa por
// aqui: é o upgrade de WebSocket, atendido no servidor HTTP.
app.use('/api/genieacs-agent', genieacsAgentFileRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/vendor-management', vendorRoutes);
app.use('/api/mapping-data', mappingRoutes);
app.use('/api/map-settings', mapSettingsRoutes);
// Switching databases copies the panel into the target and wipes whatever was
// there first, which is a reasonable thing to offer an ISP that owns its own
// install and a catastrophic one on a deployment shared by several. The route
// only exists in the self-hosted edition.
if (IS_SELF_HOSTED) {
  app.use('/api/database', databaseRoutes);
}
// The control plane is the other half of that same trade. On a self-hosted
// install there is one provider and no plane above it, so these routes must not
// merely refuse — they must not EXIST. A 403 would answer the question the
// prober was asking, which is whether a control plane is there to find.
if (IS_SAAS) {
  // E só no endereço da própria plataforma, onde há um: ver `platformHostOnly`.
  // Acima dos quatro roteadores, para que no host de um provedor estas rotas
  // não existam em vez de recusarem.
  app.use('/api/platform', platformHostOnly);
  // Two routers on one prefix, split by what they administer: the registry of
  // providers, and the people inside one. Both are gated by the same guard;
  // the split is only so two lanes could build them without sharing a file.
  app.use('/api/platform', platformRoutes);
  app.use('/api/platform', platformMemberRoutes);
  // E o cadastro do próprio console: quem tem a chave dele. Montado aqui
  // dentro como os outros, e não fora, porque um plano de controle que não
  // existe não tem a quem conceder.
  app.use('/api/platform', platformAdminRoutes);
  // E a terceira: planos, assinaturas e pagamentos — a Fase 5.
  app.use('/api/platform', platformBillingRoutes);
  // E a quarta: a conta da plataforma nos sistemas de fora (o Asaas), e o
  // provedor criado como cliente lá dentro.
  app.use('/api/platform', platformIntegrationsRoutes);
  // E a quinta: os pedidos de demonstração que a página pública recebe.
  app.use('/api/platform', platformLeadsRoutes);
  // E a sexta: os relatórios (a receita), só leitura.
  app.use('/api/platform', platformReportsRoutes);
  // A página pública do ápice — o catálogo e o que o cadastro pergunta antes
  // de existir conta. Mesma regra do console: só no endereço da plataforma.
  app.use('/api/public', platformHostOnly);
  app.use('/api/public', publicRoutes);
}
app.use('/api/users', userRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/sgp', sgpRoutes);
app.use('/api/teiah', teiahRoutes);
app.use('/api/focuschat', focusChatRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/whatsapp', whatsappMessageRoutes);
app.use('/api/whatsapp', whatsappAlertRoutes);
app.use('/api/whatsapp', whatsappBillingRoutes);
app.use('/api/provisioning', provisioningRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: req.t('common.routeNotFound') });
});

/**
 * `robots.txt` e `sitemap.xml`. Ver `services/seoFiles.js` para a regra; aqui
 * só três decisões, e nenhuma das três é livre:
 *
 * 1. **Fora de `/api`**, senão o 404 logo acima responderia por elas.
 * 2. **Acima de `serveFrontend`**, para ganhar de um arquivo físico que alguém
 *    largue no build depois — e porque o fallback da SPA não as alcança: ele
 *    pula caminhos com extensão, então hoje as duas caem no 404 do Express.
 * 3. **`app.get` escrito aqui, e não um roteador montado.** O vigia de ordem em
 *    `test/route-coverage.test.js` casa com `app.use(CONST, nomeRoutes)` e
 *    passaria a reclamar de uma montagem nova; e o inventário de rotas só varre
 *    prefixos `/api`, então estas duas não pedem declaração em `PUBLICAS`.
 *
 * `resolveTenant` está montado em `/api` e não passa por aqui: o host é lido
 * direto, como `publicPanelOrigin` já faz em `routes/genieacsAgentFiles.js`.
 */
function hostDoPedido(req) {
  return String(req.headers.host || '').trim().toLowerCase().replace(/:\d+$/, '');
}

app.get('/robots.txt', (req, res) => {
  const host = hostDoPedido(req);
  res.type('text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(robotsFor({ platformHost: isPlatformHost(host), host }));
});

app.get('/sitemap.xml', (req, res) => {
  const host = hostDoPedido(req);
  const xml = sitemapFor({ platformHost: isPlatformHost(host), host });
  // Fora do ápice o arquivo realmente não existe, e 404 é o que ele é.
  if (!xml) return res.status(404).type('text/plain; charset=utf-8').send('Not found\n');
  res.type('application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  return res.send(xml);
});

function serveFrontend(target, htmlFile) {
  if (!fs.existsSync(FRONTEND_DIR)) return false;
  target.use(express.static(FRONTEND_DIR, {
    dotfiles: 'deny',
    index: false,
    maxAge: APP_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  const htmlPath = path.join(FRONTEND_DIR, htmlFile);
  target.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || path.extname(req.path)) {
      return next();
    }
    if (!fs.existsSync(htmlPath)) {
      return res.status(503).send(req.t('common.buildUnavailable'));
    }
    res.setHeader('Cache-Control', 'no-cache');
    // Com `root`, e não com um caminho absoluto.
    //
    // `send` aplica a regra de dotfiles ao caminho que ele RESOLVE. Passando o
    // absoluto, a regra cai sobre a instalação inteira: sob `/opt/.apps/panel`
    // — ou numa worktree do git sob `.claude/` — toda página respondia 404
    // enquanto os próprios assets carregavam, porque o `express.static` acima
    // tem root e portanto só examina o caminho da REQUISIÇÃO. Sintoma
    // desconcertante: `/index.html` 200 e `/` 404.
    //
    // Desligar a regra (`dotfiles: 'allow'`) resolvia e era seguro só porque
    // os dois chamadores passam literais. Com `root` ela continua LIGADA,
    // examinando apenas o nome do arquivo, e a resolução fica confinada ao
    // diretório do build — medido: uma travessia responde 403 em vez de
    // resolver. Nada vindo da requisição chega aqui hoje, então nenhum teste
    // distingue as duas formas; a diferença é entre estar seguro por causa de
    // quem chama e estar seguro por construção.
    return res.sendFile(htmlFile, { root: FRONTEND_DIR, dotfiles: 'deny' });
  });
  return true;
}

// `next` is unused but required: Express only treats a four-argument function
// as an error handler.
export function errorHandler(err, req, res, next) {
  log.error('unhandled_error', { req: req.id ?? null, method: req.method, path: String(req.originalUrl || req.url || '').split('?')[0], err });
  // A failure raised before the locale middleware ran leaves `req.t` unset.
  const t = req.t || ((key) => translate(DEFAULT_LOCALE, key));
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      message: t('common.invalidJson')
    });
  }
  // O agente do GenieACS desconectado chega aqui quando uma rota deixa o
  // erro subir: sai no mesmo formato que as rotas de equipamento dão a ele.
  if (isAgentOffline(err)) {
    return res.status(503).json(acsAgentOfflineBody(err, translateError(t, err)));
  }
  const status = err.status || 500;
  // Internal messages are revealed only when the deployment explicitly asks
  // for them; APP_ENV is unset on most installs, so "not production" would
  // leak them by default. Read from the environment and not from the
  // `APP_ENV` export, which defaults to 'development' for the startup banner
  // and turned that default into "show everything".
  res.status(status).json({
    success: false,
    message: status >= 500 && process.env.APP_ENV !== 'development'
      ? t('common.internalError')
      : (translateError(t, err) || t('common.internalError'))
  });
}

/**
 * A página do Embedded Signup da Meta (`frontend/public/whatsapp-signup.html`,
 * servida pelo `express.static` de `serveFrontend` logo abaixo) carrega o SDK
 * JS do Facebook, que abre um iframe oculto e fala com a Graph. A CSP do
 * painel não deixa — `script-src` é só `'self'` — e continua não deixando em
 * todo o resto: só nesta URL os domínios do Facebook entram, e só eles. O
 * script da página é um arquivo externo (`whatsapp-signup.js`), então inline
 * segue bloqueado aqui também, inclusive `onclick=` (`script-src-attr 'none'`).
 *
 * O helmet grava o cabeçalho e segue (`setHeader` + `next()`), então um
 * segundo `contentSecurityPolicy` montado depois dele apenas sobrescreve o
 * valor nesta rota, com os mesmos padrões dele para o que não é dito aqui.
 * A janela do `FB.login` é um popup: não passa pela CSP, mas depende de COOP
 * desligado (`crossOriginOpenerPolicy: false`, acima) para avisar o opener.
 *
 * Sem filtro por host: a Meta só aceita o SDK na origem cadastrada no app
 * (`tr69.com.br`), então em qualquer outro nome a página abre e o botão falha.
 */
const CSP_DIRECTIVES = helmetOptions.contentSecurityPolicy.directives;
app.get('/whatsapp-signup.html', helmet.contentSecurityPolicy({
  directives: {
    ...CSP_DIRECTIVES,
    scriptSrc: ["'self'", 'https://connect.facebook.net'],
    // O `xd_arbiter` do SDK e o status de login; `web.` é o host que a Meta
    // usa em parte do Brasil.
    frameSrc: ['https://www.facebook.com', 'https://web.facebook.com', 'https://staticxx.facebook.com'],
    connectSrc: ["'self'", 'https://www.facebook.com', 'https://web.facebook.com', 'https://graph.facebook.com'],
    imgSrc: [...CSP_DIRECTIVES.imgSrc, 'https://www.facebook.com']
  }
}));

if (!serveFrontend(app, 'index.html')) {
  console.warn(`Frontend build not found at ${FRONTEND_DIR}; serving API only`);
}
app.use(errorHandler);

function portalOriginGuard(req, res, next) {
  const origin = req.get('origin');
  if (origin && !isAllowedOrigin(req, origin)) {
    return res.status(403).json({ success: false, message: req.t('common.originNotAllowed') });
  }
  const fetchSite = req.get('sec-fetch-site');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    fetchSite &&
    !['same-origin', 'none'].includes(fetchSite)
  ) {
    return res.status(403).json({ success: false, message: req.t('common.crossSiteBlocked') });
  }
  return next();
}

portalApp.use(attachLocale);
portalApp.use(portalOriginGuard);
portalApp.use(express.json({ limit: '16kb' }));
// The login limiter keys on the submitted customer ID, so it must see a parsed body.
portalApp.use('/api/customer/login', portalLoginLimiter);
portalApp.use('/api', portalIpLimiter);
// Ahead of the resolver for the same reason as the panel's.
portalApp.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'customer-portal', version: APP_VERSION });
});
portalApp.use('/api', requestLogger());
portalApp.use('/api', httpMetrics());
portalApp.use('/api', resolveTenant);
portalApp.use('/api/customer', customerPortalRoutes);
portalApp.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: req.t('common.routeNotFound') });
});

/**
 * O portal do assinante é privado por inteiro — não tem uma página que faça
 * sentido indexar. Precisa da sua própria rota porque é outro app Express:
 * `portalApp` divide o `FRONTEND_DIR` com o painel, mas não a cadeia de
 * middleware, então o `/robots.txt` de cima não responde aqui.
 */
portalApp.get('/robots.txt', (req, res) => {
  res.type('text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(robotsFor({ platformHost: false, host: '' }));
});

serveFrontend(portalApp, 'portal.html');
portalApp.use(errorHandler);

export default app;

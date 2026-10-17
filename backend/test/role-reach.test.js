import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O alcance de cada papel, provado por HTTP.
 *
 * A onda 17 trocou `requireRole(['admin'])` por 24 capacidades numa matriz só,
 * e `permissions.test.js` prova a matriz — mas prova só a matriz. Ele lê
 * `roleHas` em memória e varre o texto das rotas com uma regex; nada ali
 * atravessa o servidor. Um `requirePermission` montado depois do controlador,
 * uma rota que esqueceu a guarda, um `authenticateToken` que não popula
 * `req.user`: nada disso aparece numa varredura estática, e o papel `tech`
 * inteiro é entrega nova — ninguém nunca o exercitou contra o Express.
 *
 * Aqui cada papel loga de verdade em `POST /api/auth/login` e bate na rota de
 * verdade. Duas coisas são provadas por caso, e a segunda é a que dá sentido à
 * primeira:
 *
 *   1. quem NÃO tem a capacidade recebe 403 com `code: 'missing_permission'`;
 *   2. quem TEM a capacidade recebe, no MESMO caminho e com o MESMO corpo, uma
 *      resposta que não é 403 — e que está na lista curta de status que aquela
 *      rota pode honestamente dar.
 *
 * Sem (2) o arquivo inteiro passaria com os caminhos digitados errado: um 403
 * é de graça, e uma rota inexistente sob um token qualquer também recusa. É a
 * mesma forma de `tenant-id-sweep.test.js`, pelo mesmo motivo.
 *
 * ## O que este arquivo NÃO afirma
 *
 * São **60 rotas**, não as 91. A amostra foi escolhida para que cada uma das
 * 38 capacidades apareça pelo menos uma vez, e a garantia de não-regressão que
 * o teste do `admin` dá vale **sobre estas 60** — não sobre o painel inteiro.
 * Quem quiser a afirmação forte ("nenhuma das 91 rotas mudou de dono") precisa
 * de outra prova; a varredura estática de `permissions.test.js` é o que existe
 * hoje mais perto disso, e ela olha o nome da capacidade, não o alcance.
 *
 * ## Por que `QUEM_TEM` é escrito à mão
 *
 * Derivar as duas listas de `roleHas()` seria mais curto e provaria nada: com
 * a matriz como fonte, mudar a matriz move o caso de "recusado" para
 * "aceito" e o arquivo continua verde qualquer que seja a política. Escrito à
 * mão, afrouxar a matriz deixa a expectativa para trás e o teste fica
 * vermelho, que é o comportamento que se quer de uma prova de autorização.
 * `a matriz e a expectativa deste arquivo` abaixo é o cruzamento entre as
 * duas, e serve para que uma mudança deliberada de política apareça como uma
 * linha a corrigir aqui, e não como um caso que sumiu.
 */

const {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { tinsertReturningId } = await import('../src/config/database.js');
const { ROLES, PERMISSIONS, roleHas } = await import('../src/config/permissions.js');

const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');

/** O aparelho que o stub do GenieACS serve, e o que as rotas de frota pedem. */
const DEVICE_ID = 'stub-device-1';

/**
 * Quem tem cada capacidade, repetido à mão a partir da matriz.
 *
 * As três primeiras são as do `viewer` e por isso não têm ninguém do lado de
 * recusado: TODO papel as tem. Elas entram assim mesmo porque a afirmação que
 * interessa nelas é a de alcance — o `viewer` chega à lista de aparelhos, ao
 * mapa e ao catálogo — e não a de recusa.
 */
const QUEM_TEM = {
  'devices.list': ['owner', 'admin', 'tech', 'viewer'],
  'map.read': ['owner', 'admin', 'tech', 'viewer'],
  'catalogue.read': ['owner', 'admin', 'tech', 'viewer'],

  'devices.inspect': ['owner', 'admin', 'tech'],
  'devices.write': ['owner', 'admin', 'tech'],
  'devices.maintain': ['owner', 'admin'],
  'devices.export': ['owner', 'admin'],
  'customers.secrets': ['owner', 'admin', 'tech'],
  'map.write': ['owner', 'admin', 'tech'],
  'sgp.read': ['owner', 'admin', 'tech'],
  'sgp.act': ['owner', 'admin', 'tech'],
  'teiah.read': ['owner', 'admin', 'tech'],
  'provisioning.read': ['owner', 'admin', 'tech'],
  'provisioning.run': ['owner', 'admin', 'tech'],
  'whatsapp.read': ['owner', 'admin', 'tech'],
  'whatsapp.send': ['owner', 'admin', 'tech'],
  'campaigns.read': ['owner', 'admin', 'tech'],
  'contacts.read': ['owner', 'admin', 'tech'],
  'contacts.edit': ['owner', 'admin', 'tech'],
  'contacts.settle': ['owner', 'admin', 'tech'],

  'catalogue.write': ['owner', 'admin'],
  'sgp.config': ['owner', 'admin'],
  'teiah.act': ['owner', 'admin'],
  'teiah.config': ['owner', 'admin'],
  'provisioning.write': ['owner', 'admin'],
  'whatsapp.config': ['owner', 'admin'],
  'campaigns.manage': ['owner', 'admin'],
  'settings.read': ['owner', 'admin'],
  'settings.write': ['owner', 'admin'],
  'operators.read': ['owner', 'admin'],
  'operators.manage': ['owner', 'admin'],
  'audit.read': ['owner', 'admin'],
  'tenant.export': ['owner', 'admin'],
  'customers.dossier': ['owner', 'admin'],
  'customers.erase': ['owner', 'admin'],
  'contacts.export': ['owner', 'admin'],
  'contacts.import': ['owner', 'admin'],
  'database.manage': ['owner', 'admin']
};

let panelUrl;
let genie;
let tenantId;

/** Um token por papel, conferido no `before`. */
const tokens = {};
/** Os ids semeados que os caminhos abaixo endereçam. */
const ids = {};

/**
 * A amostra.
 *
 * `aceito` é a lista curta de status que a rota pode dar a quem TEM a
 * capacidade. Ela é a asserção, e não um `!== 403`: um 401 (token que não saiu)
 * e um 404 (caminho digitado errado) também não são 403, e passariam. Onde a
 * rota alcança GenieACS o stub responde, então até essas dão status exato.
 *
 * Os corpos são escolhidos para serem repetíveis: cada caso roda uma vez por
 * papel, e um POST que cria devolveria 201 na primeira e 409 na segunda, o que
 * transformaria "quem pode" em "quem chegou primeiro". Por isso as escritas
 * são PUT/PATCH sobre linha semeada, e não POST de criação.
 */
const CASOS = [
  // ── O que o viewer alcança ────────────────────────────────────────────
  {
    cap: 'devices.list',
    label: 'GET /api/devices',
    method: 'GET',
    path: () => '/api/devices',
    aceito: [200]
  },
  {
    cap: 'devices.list',
    label: 'GET /api/devices/faults',
    method: 'GET',
    path: () => '/api/devices/faults',
    aceito: [200]
  },
  {
    cap: 'map.read',
    label: 'GET /api/mapping-data/nodes',
    method: 'GET',
    path: () => '/api/mapping-data/nodes',
    aceito: [200]
  },
  {
    cap: 'map.read',
    label: 'GET /api/map-settings',
    method: 'GET',
    path: () => '/api/map-settings',
    aceito: [200]
  },
  {
    cap: 'catalogue.read',
    label: 'GET /api/vendor-management',
    method: 'GET',
    path: () => '/api/vendor-management',
    aceito: [200]
  },

  // ── O plantão: alcança, e o viewer não ────────────────────────────────
  {
    cap: 'devices.inspect',
    label: 'GET /api/devices/:deviceId',
    method: 'GET',
    path: () => `/api/devices/${DEVICE_ID}`,
    aceito: [200]
  },
  {
    cap: 'devices.inspect',
    label: 'GET /api/devices/swaps',
    method: 'GET',
    path: () => '/api/devices/swaps',
    aceito: [200]
  },
  {
    cap: 'devices.write',
    label: 'POST /api/devices/reboot',
    method: 'POST',
    path: () => '/api/devices/reboot',
    body: { deviceId: DEVICE_ID },
    aceito: [200]
  },
  {
    // Ping pela ONT: é do plantão, então `tech` passa e `viewer` não.
    cap: 'devices.write',
    label: 'POST /api/devices/diagnostics',
    method: 'POST',
    path: () => '/api/devices/diagnostics',
    body: { deviceId: DEVICE_ID, kind: 'ping', host: '8.8.8.8' },
    aceito: [200]
  },
  {
    cap: 'devices.write',
    label: 'POST /api/devices/diagnostics/result',
    method: 'POST',
    path: () => '/api/devices/diagnostics/result',
    body: { deviceId: DEVICE_ID, kind: 'ping' },
    aceito: [200]
  },
  {
    cap: 'devices.maintain',
    label: 'POST /api/devices/batch',
    method: 'POST',
    path: () => '/api/devices/batch',
    body: { action: 'reboot', deviceIds: [DEVICE_ID] },
    aceito: [200]
  },
  {
    cap: 'devices.maintain',
    label: 'GET /api/devices/firmware/files',
    method: 'GET',
    path: () => '/api/devices/firmware/files',
    aceito: [200]
  },
  {
    cap: 'devices.maintain',
    label: 'GET /api/devices/firmware',
    method: 'GET',
    path: () => `/api/devices/firmware?deviceId=${DEVICE_ID}`,
    aceito: [200]
  },
  {
    cap: 'devices.maintain',
    label: 'POST /api/devices/firmware/upgrade',
    method: 'POST',
    path: () => '/api/devices/firmware/upgrade',
    body: { deviceId: DEVICE_ID, fileId: 'f670l-v9.bin' },
    aceito: [200]
  },
  {
    // O reset de fábrica, com o número de série certo — o do aparelho que o
    // stub serve. Com a série errada a rota daria 400, que provaria alcance mas
    // não distinguiria "passou pela guarda" de "parou na conferência".
    cap: 'devices.maintain',
    label: 'POST /api/devices/factory-reset',
    method: 'POST',
    path: () => '/api/devices/factory-reset',
    // A senha de QUEM pede, duas vezes: o reset também exige a do operador.
    body: (papel) => ({
      deviceId: DEVICE_ID,
      confirmSerial: 'ZTEG12345678',
      password: `senha-do-${papel}-1`,
      passwordConfirm: `senha-do-${papel}-1`
    }),
    aceito: [200]
  },
  {
    cap: 'devices.write',
    label: 'POST /api/devices/:id/update-wifi',
    method: 'POST',
    path: () => `/api/devices/${DEVICE_ID}/update-wifi`,
    body: { index: 1, formData: { ssid: 'Plantao-3h' } },
    aceito: [200]
  },
  {
    cap: 'devices.write',
    label: 'POST /api/devices/swaps/:id/acknowledge',
    method: 'POST',
    path: () => `/api/devices/swaps/${ids.swap}/acknowledge`,
    aceito: [200]
  },
  {
    cap: 'customers.secrets',
    label: 'GET /api/devices/:deviceId/portal-password',
    method: 'GET',
    path: () => `/api/devices/${DEVICE_ID}/portal-password`,
    aceito: [200]
  },
  {
    cap: 'customers.secrets',
    label: 'POST /api/devices/:deviceId/portal-password/reset',
    method: 'POST',
    path: () => `/api/devices/${DEVICE_ID}/portal-password/reset`,
    aceito: [200]
  },
  {
    cap: 'map.write',
    label: 'PUT /api/mapping-data/nodes/:nodeId',
    method: 'PUT',
    path: () => '/api/mapping-data/nodes/caixa-1',
    body: { type: 'odp', name: 'Caixa 1', latitude: -23.55, longitude: -46.63 },
    aceito: [200]
  },
  {
    cap: 'map.write',
    label: 'POST /api/mapping-data/import',
    method: 'POST',
    path: () => '/api/mapping-data/import',
    // Vazio de propósito: importar nada é repetível, e acrescentar não apaga.
    body: { nodes: [], edges: [] },
    aceito: [200]
  },
  {
    cap: 'sgp.read',
    label: 'GET /api/sgp/events',
    method: 'GET',
    path: () => '/api/sgp/events',
    aceito: [200]
  },
  {
    cap: 'sgp.act',
    label: 'POST /api/sgp/events/:id/retry',
    method: 'POST',
    path: () => `/api/sgp/events/${ids.event}/retry`,
    aceito: [200]
  },
  {
    cap: 'provisioning.read',
    label: 'GET /api/provisioning/profiles',
    method: 'GET',
    path: () => '/api/provisioning/profiles',
    aceito: [200]
  },
  {
    cap: 'provisioning.run',
    label: 'POST /api/provisioning/run',
    method: 'POST',
    path: () => '/api/provisioning/run',
    body: {},
    aceito: [200]
  },
  {
    cap: 'whatsapp.read',
    label: 'GET /api/whatsapp/accounts',
    method: 'GET',
    path: () => '/api/whatsapp/accounts',
    aceito: [200]
  },
  {
    cap: 'whatsapp.send',
    label: 'POST /api/whatsapp/messages/requeue-failed',
    method: 'POST',
    path: () => '/api/whatsapp/messages/requeue-failed',
    body: {},
    aceito: [200]
  },
  {
    /**
     * A integração do WhatsApp NÃO está ligada neste teste, de propósito:
     * ligá-la exigiria um servidor Evolution de mentira e não acrescentaria
     * nada à afirmação. Por isso o aceito é 400 `not_configured` — que é a
     * resposta de quem PASSOU pela guarda e parou no `requireConfig` do
     * controlador, e é o que separa "não pode" de "não tem para onde mandar".
     */
    cap: 'whatsapp.send',
    label: 'POST /api/whatsapp/accounts/check-number',
    method: 'POST',
    path: () => '/api/whatsapp/accounts/check-number',
    body: { numbers: ['5511900000001'] },
    aceito: [400],
    codigoAceito: 'not_configured'
  },
  {
    cap: 'campaigns.read',
    label: 'GET /api/whatsapp/templates',
    method: 'GET',
    path: () => '/api/whatsapp/templates',
    aceito: [200]
  },

  {
    // Uma chave que não existe: quem passa pela guarda chega à busca da ficha
    // e ouve 404 `not_found`, que é o que separa "não pode" de "não há".
    cap: 'contacts.read',
    label: 'GET /api/contacts/:key',
    method: 'GET',
    path: () => '/api/contacts/CONTRATO-QUE-NAO-EXISTE',
    aceito: [404],
    codigoAceito: 'not_found'
  },
  {
    cap: 'contacts.edit',
    label: 'POST /api/contacts',
    method: 'POST',
    path: () => '/api/contacts',
    body: { name: 'Cliente do alcance' },
    aceito: [201]
  },
  {
    // Receber dá baixa no SGP: quem passa pela guarda chega à busca da ficha.
    cap: 'contacts.settle',
    label: 'POST /api/contacts/:key/invoices/:invoiceId/settle',
    method: 'POST',
    path: () => '/api/contacts/CONTRATO-QUE-NAO-EXISTE/invoices/T-1/settle',
    body: { amount: 10, method: 'PIX' },
    aceito: [404],
    codigoAceito: 'not_found'
  },
  {
    // O status do serviço pergunta ao ACS: quem passa pela guarda chega à busca da ficha.
    cap: 'devices.inspect',
    label: 'GET /api/contacts/:key/service-status',
    method: 'GET',
    path: () => '/api/contacts/CONTRATO-QUE-NAO-EXISTE/service-status',
    aceito: [404],
    codigoAceito: 'not_found'
  },
  {
    // A TeiaH da ficha manda um CPF/CNPJ para fora: é do `teiah.act`, que o
    // plantão não tem. A chave que não existe dá 404 antes de qualquer consulta.
    cap: 'teiah.act',
    label: 'POST /api/contacts/:key/teiah',
    method: 'POST',
    path: () => '/api/contacts/CONTRATO-QUE-NAO-EXISTE/teiah',
    aceito: [404],
    codigoAceito: 'not_found'
  },
  {
    cap: 'teiah.act',
    label: 'POST /api/contacts/:key/teiah/apply',
    method: 'POST',
    path: () => '/api/contacts/CONTRATO-QUE-NAO-EXISTE/teiah/apply',
    aceito: [404],
    codigoAceito: 'not_found'
  },
  {
    // Sem a TeiaH ligada e sem cliente a consultar, a passada acaba vazia.
    cap: 'teiah.act',
    label: 'POST /api/contacts/teiah/phones/scan',
    method: 'POST',
    path: () => '/api/contacts/teiah/phones/scan',
    aceito: [200]
  },
  {
    cap: 'teiah.act',
    label: 'GET /api/contacts/teiah/phones',
    method: 'GET',
    path: () => '/api/contacts/teiah/phones',
    aceito: [200]
  },
  {
    cap: 'teiah.act',
    label: 'POST /api/contacts/teiah/phones/apply',
    method: 'POST',
    path: () => '/api/contacts/teiah/phones/apply',
    body: { keys: [] },
    aceito: [200]
  },
  {
    // Sincronizar grava a ficha: só quem edita. A chave que não existe dá 404.
    cap: 'contacts.edit',
    label: 'POST /api/contacts/:key/sync',
    method: 'POST',
    path: () => '/api/contacts/CONTRATO-QUE-NAO-EXISTE/sync',
    aceito: [404],
    codigoAceito: 'not_found'
  },

  // ── O que só quem administra alcança ──────────────────────────────────
  {
    // A planilha do inventário. O viewer e o plantão veem a lista e não levam
    // a base toda num arquivo.
    cap: 'devices.export',
    label: 'GET /api/devices/export',
    method: 'GET',
    path: () => '/api/devices/export',
    aceito: [200]
  },
  {
    cap: 'contacts.export',
    label: 'GET /api/contacts/export',
    method: 'GET',
    path: () => '/api/contacts/export',
    aceito: [200]
  },
  {
    // Uma planilha sem linhas: quem passa pela guarda chega à leitura e ouve
    // 400 `empty`, que é o que separa "não pode" de "não mandou nada".
    cap: 'contacts.import',
    label: 'POST /api/contacts/import',
    method: 'POST',
    path: () => '/api/contacts/import?mode=preview',
    body: {},
    aceito: [400],
    codigoAceito: 'empty'
  },
  {
    // Sem o WhatsApp ligado, quem passa pela guarda ouve 400 `not_configured`.
    cap: 'contacts.import',
    label: 'POST /api/contacts/import/whatsapp',
    method: 'POST',
    path: () => '/api/contacts/import/whatsapp?mode=preview',
    body: {},
    aceito: [400],
    codigoAceito: 'not_configured'
  },
  {
    // Sem o token do Focus Chat, quem passa pela guarda ouve 409 `not_configured`.
    cap: 'contacts.import',
    label: 'POST /api/contacts/import/focuschat',
    method: 'POST',
    path: () => '/api/contacts/import/focuschat?mode=preview',
    body: {},
    aceito: [409],
    codigoAceito: 'not_configured'
  },
  {
    cap: 'catalogue.write',
    label: 'PUT /api/vendor-management/:id',
    method: 'PUT',
    path: () => `/api/vendor-management/${ids.vendor}`,
    body: {
      name: 'Fabricante Semeado',
      manufacturer_patterns: ['ACME'],
      product_patterns: ['AC-1000'],
      parameter_prefix: 'InternetGatewayDevice'
    },
    aceito: [200]
  },
  {
    cap: 'sgp.config',
    label: 'GET /api/sgp/config',
    method: 'GET',
    path: () => '/api/sgp/config',
    aceito: [200]
  },
  {
    cap: 'teiah.read',
    label: 'GET /api/teiah/export',
    method: 'GET',
    path: () => '/api/teiah/export',
    aceito: [200]
  },
  {
    // Sem a TeiaH configurada o envio é recusado com 409 — DEPOIS da guarda, e
    // repetível: nada é enviado a ninguém.
    cap: 'teiah.act',
    label: 'POST /api/teiah/export/run',
    method: 'POST',
    path: () => '/api/teiah/export/run',
    aceito: [409],
    codigoAceito: 'not_configured'
  },
  {
    cap: 'teiah.config',
    label: 'GET /api/teiah/config',
    method: 'GET',
    path: () => '/api/teiah/config',
    aceito: [200]
  },
  {
    cap: 'provisioning.write',
    label: 'PUT /api/provisioning/profiles/:id',
    method: 'PUT',
    path: () => `/api/provisioning/profiles/${ids.profile}`,
    body: { name: 'perfil-semeado', priority: 10, enabled: true },
    aceito: [200]
  },
  {
    cap: 'whatsapp.config',
    label: 'GET /api/whatsapp/config',
    method: 'GET',
    path: () => '/api/whatsapp/config',
    aceito: [200]
  },
  {
    // A mensagem de teste do Telegram dos alertas. Sem bot configurado, o 400
    // só se alcança DEPOIS da guarda — e a chamada não manda nada a ninguém.
    cap: 'whatsapp.config',
    label: 'POST /api/whatsapp/alerts/telegram/test',
    method: 'POST',
    path: () => '/api/whatsapp/alerts/telegram/test',
    body: {},
    aceito: [400],
    codigoAceito: 'telegram_not_configured'
  },
  {
    cap: 'campaigns.manage',
    label: 'PUT /api/whatsapp/templates/:id',
    method: 'PUT',
    path: () => `/api/whatsapp/templates/${ids.template}`,
    body: { name: 'segunda-via', body: 'Olá {{nome}}', category: 'cobranca' },
    aceito: [200]
  },
  {
    cap: 'settings.read',
    label: 'GET /api/settings',
    method: 'GET',
    path: () => '/api/settings',
    aceito: [200]
  },
  {
    cap: 'settings.read',
    label: 'GET /api/settings/onboarding',
    method: 'GET',
    path: () => '/api/settings/onboarding',
    aceito: [200]
  },
  {
    // Repetível: marcar de novo só regrava o carimbo.
    cap: 'settings.write',
    label: 'POST /api/settings/onboarding/dismiss',
    method: 'POST',
    path: () => '/api/settings/onboarding/dismiss',
    body: { what: 'checklist' },
    aceito: [200]
  },
  {
    // `appName` já existe em toda instalação (é um dos `DEFAULT_SETTINGS`) e o
    // corpo repete o valor que ela tem: a chamada é repetível, e o que muda de
    // um papel para o outro é só quem pode fazê-la.
    cap: 'settings.write',
    label: 'PUT /api/settings/:key',
    method: 'PUT',
    path: () => '/api/settings/appName',
    body: { value: 'TR69 Controle' },
    aceito: [200]
  },
  // A conexão com o GenieACS (direto ou pelo agente) e a chave do agente: ler
  // em `settings.read`, como `/genieacs-auth`; mudar e gerar chave em
  // `settings.write`, a permissão que grava o `genieAcsUrl`.
  {
    cap: 'settings.read',
    label: 'GET /api/settings/genieacs-connection',
    method: 'GET',
    path: () => '/api/settings/genieacs-connection',
    aceito: [200]
  },
  {
    // Repetível: o modo já é `direct`, e gravar o mesmo não muda nada.
    cap: 'settings.write',
    label: 'PUT /api/settings/genieacs-connection',
    method: 'PUT',
    path: () => '/api/settings/genieacs-connection',
    body: { mode: 'direct' },
    aceito: [200]
  },
  {
    // Com o modo em `direct` a geração é recusada com 409 — DEPOIS da guarda:
    // o `code` prova que a requisição chegou ao controlador, e é repetível,
    // ao contrário de um 201 que trocaria a chave a cada papel.
    cap: 'settings.write',
    label: 'POST /api/settings/genieacs-connection/agent-token',
    method: 'POST',
    path: () => '/api/settings/genieacs-connection/agent-token',
    aceito: [409],
    codigoAceito: 'mode_not_agent'
  },
  {
    cap: 'settings.read',
    label: 'GET /api/tenant/security',
    method: 'GET',
    path: () => '/api/tenant/security',
    aceito: [200]
  },
  {
    // O corpo inválido é de propósito: o 400 vem depois da guarda e ANTES da
    // regra do dono, então o `owner` e o `admin` recebem a mesma resposta e o
    // caso mede só a capacidade. Com um corpo válido o `admin` levaria o 403 de
    // `users.ownerOnly`, que é outra regra, provada em `mfa-policy.test.js`.
    cap: 'settings.write',
    label: 'PUT /api/tenant/security',
    method: 'PUT',
    path: () => '/api/tenant/security',
    body: { requireMfa: 'sim' },
    aceito: [400]
  },
  {
    cap: 'operators.read',
    label: 'GET /api/users',
    method: 'GET',
    path: () => '/api/users',
    aceito: [200]
  },
  {
    // A trilha de auditoria. Capacidade própria e não `operators.read`: ela diz
    // mais do que a equipe — quem revelou a senha de qual assinante, e quando.
    cap: 'audit.read',
    label: 'GET /api/audit',
    method: 'GET',
    path: () => '/api/audit',
    aceito: [200]
  },
  {
    // O cadastro inteiro num arquivo. Capacidade própria: quem administra a
    // operação não recebe de brinde o direito de baixar tudo de uma vez.
    cap: 'tenant.export',
    label: 'GET /api/tenant/export',
    method: 'GET',
    path: () => '/api/tenant/export',
    aceito: [200]
  },
  {
    /**
     * O alvo é um quinto operador semeado só para isto, e o corpo repete o
     * papel que ele já tem. Mexer num dos quatro que fazem as perguntas
     * mudaria o papel debaixo do próprio teste.
     */
    cap: 'operators.manage',
    label: 'PATCH /api/users/:id',
    method: 'PATCH',
    path: () => `/api/users/${ids.alvo}`,
    body: { role: 'viewer' },
    aceito: [200]
  },
  {
    // O mesmo alvo, que não tem 2FA: o 409 só se alcança depois da guarda e de
    // achar a pessoa na equipe, e repetir a chamada não muda nada.
    cap: 'operators.manage',
    label: 'POST /api/users/:id/mfa-reset',
    method: 'POST',
    path: () => `/api/users/${ids.alvo}/mfa-reset`,
    aceito: [409],
    codigoAceito: 'mfa_not_enabled'
  },
  {
    // O dossiê de UM assinante. Capacidade própria e não `customers.secrets`:
    // revelar uma senha para destravar um atendimento e produzir o dossiê
    // consolidado de uma pessoa são atos de altura diferente, e o segundo não é
    // do plantão das três da manhã.
    cap: 'customers.dossier',
    label: 'GET /api/customers/:accountId/export',
    method: 'GET',
    path: () => `/api/customers/${ids.conta}/export`,
    aceito: [200]
  },
  {
    /**
     * A exclusão, sem o corpo de confirmação — de propósito.
     *
     * O 409 é a resposta honesta de quem passou pela guarda de capacidade E
     * achou a conta: a confirmação por `customer_id` digitado é conferida
     * DEPOIS do 404. Mandar a confirmação certa apagaria o assinante que os
     * outros casos deste arquivo endereçam, e a segunda chamada (a do outro
     * papel que tem a capacidade) rodaria contra uma conta que já não existe.
     */
    cap: 'customers.erase',
    label: 'DELETE /api/customers/:accountId',
    method: 'DELETE',
    path: () => `/api/customers/${ids.conta}`,
    aceito: [409]
  },
  {
    cap: 'database.manage',
    label: 'GET /api/database/config',
    method: 'GET',
    path: () => '/api/database/config',
    aceito: [200]
  }
];

/** Uma chamada com o token de um papel. */
function pedir(papel, caso) {
  return call(`${panelUrl}${caso.path()}`, {
    method: caso.method,
    headers: authHeaders(tokens[papel]),
    body: typeof caso.body === 'function' ? caso.body(papel) : caso.body
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());

  // O stub responde pelo GenieACS para que as rotas de frota deem status
  // exato. Sem ele `GET /api/devices` responde 500 "URL not configured", e um
  // 500 provaria alcance mas não distinguiria "passou pela guarda" de "quebrou
  // antes dela" tão bem quanto um 200 distingue.
  genie = await startGenieAcsStub({ devices: [buildDevice({ id: DEVICE_ID })] });
  // Um firmware do modelo do aparelho do stub, para a troca passar da guarda
  // e chegar ao ACS — sem ele a rota daria 400 e não distinguiria as duas coisas.
  genie.state.files = [{
    _id: 'f670l-v9.bin',
    metadata: { fileType: '1 Firmware Upgrade Image', oui: '', productClass: 'F670L', version: 'V9.9' }
  }];

  const db = getDb();
  tenantId = (await db('tenants').orderBy('id', 'asc').first()).id;

  const bcrypt = (await import('bcryptjs')).default;

  /**
   * Um operador por papel, criado pelo modelo e vinculado em `tenant_users`.
   *
   * `/auth/setup` não serve: ele só cunha o PRIMEIRO administrador de um
   * provedor que ainda não tem nenhum, e o que decide a autorização é o papel
   * do VÍNCULO, não `users.role` — `authenticateToken` relê a membership a
   * cada requisição.
   */
  const criarOperador = async (nome, papel) => {
    const senha = `senha-do-${nome}-1`;
    const userId = await runInTenant(tenantId, () => User.create({
      username: `op-${nome}`, password: bcrypt.hashSync(senha, 10), role: papel
    }));
    await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId, role: papel }));
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: `op-${nome}`, password: senha }
    });
    // Sem esta conferência um login que falhou deixaria `Bearer undefined`, que
    // responde 401 em tudo — e todo caso de recusa passaria pelo motivo errado.
    assert.ok(login.body?.data?.token, `o ${nome} precisa de um token`);
    return { userId, token: login.body.data.token };
  };

  for (const papel of ROLES) {
    tokens[papel] = (await criarOperador(papel, papel)).token;
  }
  // Um quinto operador, que só existe para ser o alvo de `PATCH /api/users/:id`.
  // Sem ele o caso mexeria no papel de quem está fazendo as perguntas, e a
  // segunda chamada da mesma rota rodaria com um token que já não vale o que
  // valia na primeira.
  ids.alvo = (await criarOperador('alvo', 'viewer')).userId;

  /**
   * As linhas que os caminhos endereçam, gravadas por `tinsertReturningId` sob
   * `runInTenant` e nunca pelo `create` do modelo. O motivo está em
   * `tenant-id-sweep.test.js`: quase todo `create` lê antes de escrever, e essa
   * leitura passa pelos mesmos mecanismos que o teste existe para exercitar —
   * um fixture tem que ser independente deles, ou o dia em que quebrarem é o
   * dia em que os casos aparecem como "cancelled" em vez de vermelhos.
   */
  await runInTenant(tenantId, async () => {
    const semear = async (tabela, linha) => {
      const id = await tinsertReturningId(tabela, linha);
      assert.ok(id, `o seed de ${tabela} não gravou`);
      return id;
    };

    ids.swap = await semear('device_swaps', {
      previous_device_id: 'ONT-ANTIGA', device_id: DEVICE_ID,
      matched_by: 'pppoe', link_action: 'kept'
    });
    ids.event = await semear('sgp_events', {
      dedupe_key: 'sgp-evento-4242', source: 'webhook', type: 'suspend',
      contract: '4242', status: 'pending', payload: '{}'
    });
    ids.vendor = await semear('vendors', {
      name: 'Fabricante Semeado',
      manufacturer_patterns: JSON.stringify(['ACME']),
      product_patterns: JSON.stringify(['AC-1000']),
      parameter_prefix: 'InternetGatewayDevice'
    });
    ids.profile = await semear('provisioning_profiles', {
      name: 'perfil-semeado', priority: 10, enabled: true
    });
    ids.template = await semear('wa_templates', {
      name: 'segunda-via', body: 'Olá {{nome}}', category: 'cobranca', active: true
    });
    await semear('mapping_nodes', {
      node_id: 'caixa-1', type: 'odp', name: 'Caixa 1', latitude: -23.55, longitude: -46.63
    });
    // O assinante atrás da ONT. Sem esta linha `portal-password` responde 404
    // por não achar a conta, e um 404 é justamente o que este arquivo não pode
    // confundir com alcance.
    ids.conta = await semear('customer_accounts', {
      customer_id: 'CLI0001', device_id: DEVICE_ID,
      identity_hash: 'f'.repeat(64), software_id: 'V1.0.0',
      pppoe_username: 'joao@provedor', active: true
    });
  });

  // O painel só fala com o GenieACS quando sabe o endereço dele. A chave já
  // existe vazia desde `seedDefaults`, então é UPDATE e não INSERT — e vai
  // pelo knex cru, com o provedor escrito à mão, pela mesma razão que o resto
  // do seed: `settings.write` é uma das capacidades sob teste, e semear pela
  // rota faria o fixture depender do mecanismo.
  const gravadas = await db('settings')
    .where({ tenant_id: tenantId, key: 'genieAcsUrl' })
    .update({ value: genie.url });
  assert.equal(gravadas, 1, 'o endereço do GenieACS precisa estar gravado');

  // A senha do portal tem que existir para ser revelada; o reset é a única
  // porta que a grava, e ele é `customers.secrets` — que é capacidade sob
  // teste. Usar o token do dono aqui é o fixture, não a prova.
  const gerada = await call(
    `${panelUrl}/api/devices/${DEVICE_ID}/portal-password/reset`,
    { method: 'POST', headers: authHeaders(tokens.owner) }
  );
  assert.equal(gerada.status, 200, `o fixture precisa da senha gravada: ${JSON.stringify(gerada.body)}`);
});

after(async () => {
  // Guardado porque o `before` pode ter estourado antes de o stub subir, e um
  // `after` que quebra esconde a falha de verdade atrás de um TypeError.
  if (genie) await genie.close();
  await stopTestServers();
});

describe('a matriz e a expectativa deste arquivo', () => {
  it('dizem a mesma coisa sobre cada capacidade da amostra', () => {
    // As duas listas são escritas em lugares diferentes de propósito (ver o
    // cabeçalho). Este é o cruzamento: uma mudança deliberada de política vira
    // uma linha a corrigir em `QUEM_TEM`, e não um caso que sumiu.
    for (const [cap, papeis] of Object.entries(QUEM_TEM)) {
      for (const papel of ROLES) {
        assert.equal(roleHas(papel, cap), papeis.includes(papel),
          `${papel} × ${cap}: a matriz e QUEM_TEM discordam`);
      }
    }
  });

  it('cobre as 38 capacidades', () => {
    // Uma capacidade fora da amostra é uma rota sem prova de alcance nenhuma.
    const deFora = PERMISSIONS.filter((cap) => !QUEM_TEM[cap]);
    assert.deepEqual(deFora, [], `capacidades sem caso: ${deFora.join(', ')}`);
    const semRota = PERMISSIONS.filter((cap) => !CASOS.some((caso) => caso.cap === cap));
    assert.deepEqual(semRota, [], `capacidades sem rota na amostra: ${semRota.join(', ')}`);
  });

  it('tem par de recusa para toda capacidade que algum papel não tem', () => {
    /**
     * A afirmação central do arquivo, conferida sobre a própria amostra: 35 das
     * 38 capacidades têm alguém do lado de fora, e cada uma delas precisa de
     * pelo menos uma rota onde essa recusa é exercitada. As 3 restantes são as
     * do `viewer`, que TODO papel tem — para elas não existe par de recusa a
     * escrever, e dizer o número aqui é o que impede que uma capacidade caia
     * silenciosamente para dentro do `viewer` sem ninguém notar.
     */
    const comRecusa = PERMISSIONS.filter((cap) => QUEM_TEM[cap].length < ROLES.length);
    assert.equal(comRecusa.length, 35);
    for (const cap of comRecusa) {
      assert.ok(CASOS.some((caso) => caso.cap === cap), `${cap} sem rota para recusar`);
    }
  });

  it('não encolhe sem que alguém diga', () => {
    // O cabeçalho promete uma amostra de 65 rotas e a promessa de não-regressão
    // do `admin` vale sobre ELA. Uma rota apagada por um merge desajeitado
    // deixaria a promessa valendo sobre menos coisa, calada.
    // Eram 54; as três da conexão com o GenieACS (modo agente) entraram juntas,
    // e depois as três da TeiaH Valid, e a importação da agenda do WhatsApp.
    assert.equal(CASOS.length, 70);
  });
});

/**
 * A recusa. Cada caso é o par do "aceito" logo abaixo: mesmo caminho, mesmo
 * corpo, só o token muda.
 */
describe('quem não tem a capacidade toma 403', () => {
  for (const caso of CASOS) {
    const recusados = ROLES.filter((papel) => !QUEM_TEM[caso.cap].includes(papel));
    for (const papel of recusados) {
      it(`${papel} em ${caso.label} (${caso.cap})`, async () => {
        const { status, body } = await pedir(papel, caso);
        // O status exato, e não `>= 400`: um 401 (token que não saiu) e um 404
        // (caminho errado) recusam do mesmo jeito e provariam nada.
        assert.equal(status, 403, `${caso.label}: ${JSON.stringify(body)}`);
        // E o `code`, porque 403 também é a resposta de `invalid_token` e de
        // `tenant_mismatch` — que são outra falha, não a falta de atribuição.
        assert.equal(body?.code, 'missing_permission', JSON.stringify(body));
      });
    }
  }
});

/**
 * O par que dá sentido ao de cima, e a garantia de não-regressão do `admin`:
 * ele aparece aqui em TODAS as 60 rotas, porque a matriz lhe dá as 37
 * capacidades. Nenhuma das rotas desta amostra saiu do alcance dele na onda 17.
 */
describe('quem tem a capacidade passa pela guarda', () => {
  for (const caso of CASOS) {
    for (const papel of QUEM_TEM[caso.cap]) {
      it(`${papel} em ${caso.label} (${caso.cap})`, async () => {
        const { status, body } = await pedir(papel, caso);
        assert.ok(caso.aceito.includes(status),
          `${caso.label}: esperava ${caso.aceito.join('|')}, veio ${status} ${JSON.stringify(body)}`);
        // Redundante com a linha acima — `aceito` nunca contém 403 — e escrita
        // assim mesmo: é a afirmação do arquivo, e quem acrescentar um caso
        // com um `aceito` largo demais esbarra nela.
        assert.notEqual(status, 403, `${caso.label}: ${JSON.stringify(body)}`);
        if (caso.codigoAceito) {
          assert.equal(body?.code, caso.codigoAceito, JSON.stringify(body));
        }
      });
    }
  }
});

/**
 * O `viewer`, dito de uma vez.
 *
 * O recorte da onda 17 foi "o `viewer` recebe exatamente o conjunto que hoje
 * não pede papel nenhum — lista de aparelhos, mapa, catálogo — e nada mais". Os
 * dois casos acima já provam isso caso a caso; este afirma o CONJUNTO, que é a
 * frase que alguém vai querer mudar sem perceber o tamanho do que está mudando.
 */
describe('o alcance do viewer, sobre a amostra', () => {
  it('é a lista de aparelhos, o mapa e o catálogo, e nada além', () => {
    const alcanca = [...new Set(
      CASOS.filter((caso) => QUEM_TEM[caso.cap].includes('viewer')).map((caso) => caso.cap)
    )].sort();
    assert.deepEqual(alcanca, ['catalogue.read', 'devices.list', 'map.read']);
  });

  it('não alcança nada que mexa em aparelho, em gente ou em configuração', () => {
    // A amostra inteira menos as três acima, numa afirmação só: o que o
    // `viewer` NÃO alcança é 35 das 38 capacidades.
    const fechadas = PERMISSIONS.filter((cap) => !QUEM_TEM[cap].includes('viewer'));
    assert.equal(fechadas.length, 35, fechadas.join(', '));
  });
});

/**
 * A direção que a onda 17 existe para abrir, dita explicitamente.
 *
 * Um arquivo que só mostrasse recusas provaria que o `tech` é inofensivo e não
 * que ele serve para alguma coisa. O plantão às três da manhã precisa reiniciar
 * a ONT, religar o contrato no ERP, disparar a passada de provisionamento,
 * responder o assinante no WhatsApp e devolver a senha do portal — e não
 * precisa, nem deve, mexer em configuração, em operador ou no banco.
 */
describe('o tech, nas duas direções', () => {
  /** A primeira rota da amostra que exige uma capacidade. */
  const rotaDe = (cap) => {
    const caso = CASOS.find((candidato) => candidato.cap === cap);
    assert.ok(caso, `${cap} não tem rota na amostra`);
    return caso;
  };

  // Reiniciar a ONT, religar o contrato no ERP, disparar a passada, responder o
  // assinante e devolver a senha do portal: o trabalho das três da manhã.
  for (const cap of [
    'devices.write', 'sgp.act', 'provisioning.run', 'whatsapp.send', 'customers.secrets'
  ]) {
    it(`alcança ${cap}`, async () => {
      const caso = rotaDe(cap);
      const { status, body } = await pedir('tech', caso);
      assert.ok(caso.aceito.includes(status),
        `${caso.label}: esperava ${caso.aceito.join('|')}, veio ${status} ${JSON.stringify(body)}`);
    });
  }

  // E não mexe na configuração do provedor, em quem trabalha nele, nem no banco
  // — nem apaga a configuração do cliente com um reset de fábrica: reinicia e
  // ajusta o dia todo, mas o que deixa o assinante sem internet é do admin.
  for (const cap of [
    'settings.read', 'settings.write', 'operators.read', 'operators.manage',
    'database.manage', 'whatsapp.config', 'sgp.config', 'devices.maintain'
  ]) {
    it(`não alcança ${cap}`, async () => {
      const caso = rotaDe(cap);
      const { status, body } = await pedir('tech', caso);
      assert.equal(status, 403, `${caso.label}: ${JSON.stringify(body)}`);
      assert.equal(body?.code, 'missing_permission', JSON.stringify(body));
    });
  }
});

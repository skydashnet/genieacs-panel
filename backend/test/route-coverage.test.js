import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listRoutes } from './helpers/routeInventory.js';
import { casos } from './helpers/idSweepCases.js';

/**
 * A lista de portas, e a exigência de que nenhuma fique sem resposta.
 *
 * As outras suítes de tenancy provam que uma porta específica está fechada.
 * Esta prova outra coisa, que nenhuma delas consegue: que **não sobrou porta
 * fora da lista**. É um teste de contabilidade, e é de propósito — o vazamento
 * que este projeto viu de perto não foi um controlador escrito errado, foi um
 * controlador novo copiado do vizinho e ninguém lembrar de escrever a prova
 * dele. Uma rota nova aqui reprova o CI até alguém dizer, por escrito, quem
 * prova que ela está fechada.
 *
 * Três contas, e nenhuma delas aceita entrada velha: uma rota declarada que não
 * existe mais reprova junto com uma rota nova não declarada, porque uma tabela
 * que só cresce vira decoração.
 *
 * O que este arquivo NÃO faz é chamar rota nenhuma. Quem chama é a varredura em
 * `tenant-id-sweep.test.js`; aqui se confere que ela chama todas as que devia.
 */
const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** O que estabelece uma sessão. Qualquer outra coisa na frente da rota é limite ou papel. */
const GUARDAS_DE_SESSAO = new Set([
  'authenticateToken',
  'authenticatePortalCustomer',
  // O coletor de métricas: sem sessão, mas com segredo próprio conferido em
  // tempo constante, e ele mesmo cai no guarda do console quando não há token.
  'allowMetricsScraper'
]);

/**
 * Toda rota que responde sem sessão, e por quê.
 *
 * Cada uma destas é uma porta aberta para a internet. Não há nada de errado com
 * isso — é como se entra, como um ERP entrega evento e como um assinante lê a
 * própria fatura —, mas cada uma tem que ter sido escolhida, e é isso que a
 * lista registra. A conta é dos dois lados: uma rota nova sem sessão reprova,
 * e uma entrada aqui cuja rota sumiu também.
 */
const PUBLICAS = new Map([
  ['GET /api/tenant/public', 'o nome do provedor para a tela de login, atrás do resolvedor — quem responde é o host'],
  ['GET /api/auth/setup-status', 'a instalação já tem alguém? é a pergunta que a tela de instalação faz antes de existir sessão'],
  ['POST /api/auth/setup', 'cria a primeira conta do provedor; recusa se já houver uma'],
  ['POST /api/auth/signup', 'um ISP se cadastra; só na edição SaaS e só onde há domínio-base'],
  ['POST /api/auth/login', 'a porta de entrada'],
  ['POST /api/auth/refresh', 'renova a sessão com o refresh token, que é a credencial aqui'],
  ['POST /api/invites/token/preview', 'o token do convite É a credencial, vai no corpo e é conferido por hash'],
  ['POST /api/invites/token/accept', 'idem, e a senha da pessoa é conferida quando a conta já existe'],
  ['POST /api/sgp/events/webhook', 'entrega do ERP, autenticada pelo segredo do webhook'],
  ['POST /api/whatsapp-webhook', 'entrega da Evolution, montada antes do resolvedor; duas credenciais, o token da instância e o bilhete da sonda de configuração, que só devolve o nonce recebido'],
  ['POST /api/billing-webhook', 'entrega do gateway de pagamento, montada antes do resolvedor e autenticada pelo token do deploy'],
  ['GET /api/whatsapp-media/:id', 'anexo servido por um token assinado que já nomeia o provedor; prova em whatsapp-media-tenancy.test.js'],
  ['POST /api/auth/impersonate/redeem', 'o bilhete do console É a credencial: uso único, um minuto de vida, conferido por hash e contra o provedor do host'],
  ['POST /api/customer/login', 'a porta de entrada do assinante, no listener do portal'],
  ['GET /api/customer/referral', 'a página de indicação: o token assinado na query É a credencial e nomeia provedor e contrato; prova em customer-referrals.test.js'],
  ['POST /api/customer/referral', 'o cadastro do indicado: idem, token no corpo; só escreve em `customer_referrals` do provedor do token, e só se o host pode agir por ele'],
  ['POST /api/auth/password-reset', 'quem perdeu a senha não tem sessão; responde a MESMA coisa exista a conta ou não, e a prova está em password-reset.test.js'],
  ['POST /api/auth/password-reset/confirm', 'o bilhete do e-mail É a credencial: uso único, meia hora, conferido por hash, contra o provedor do host e contra o endereço atual da conta'],
  ['POST /api/auth/email/verify/confirm', 'idem, e é aberto do celular, onde não há sessão — pedir login para confirmar um link de e-mail é ensinar a equipe a cair em phishing'],
  // Os dois arquivos do agente do GenieACS. Quem os baixa é o `curl` na máquina
  // do provedor, que não tem sessão nem deve ter: a credencial do agente é a
  // chave, digitada lá, e nenhum dos dois arquivos a carrega. A prova do que
  // sai (origem conferida, nenhum segredo, 404 limpo) está em
  // genieacs-agent-files.test.js.
  ['GET /api/genieacs-agent/install.sh', 'o instalador do agente: arquivo do disco sem segredo, com a origem do painel vinda do resolvedor, nunca do Host cru'],
  ['GET /api/genieacs-agent/agent.mjs', 'o programa do agente, na versão deste painel: arquivo do disco sem segredo, inútil sem a chave'],
  // A página pública do ápice. Só existem no endereço da plataforma
  // (`platformHostOnly`), e nenhuma lê ou escreve dado de provedor; a prova
  // está em public-landing.test.js.
  ['GET /api/public/info', 'o nome do produto e o WhatsApp de contato, do ambiente'],
  ['GET /api/public/plans', 'o catálogo à venda: só planos ativos e marcados como públicos, sem id nem contagem'],
  ['GET /api/public/slug-available', 'a mesma pergunta que o cadastro faz ao gravar, feita antes; responde só livre/ocupado'],
  ['GET /api/public/cnpj', 'o cadastro da Receita, que é público; limite apertado porque sai para uma API de fora'],
  ['POST /api/public/leads', 'o pedido de demonstração; só insere, com honeypot e limite por endereço']
]);

/**
 * Toda rota endereçada por um parâmetro, e quem prova que o parâmetro do
 * vizinho não alcança a linha dele.
 *
 * `'varredura'` quer dizer "está em `tenant-id-sweep.test.js`", e isso é
 * conferido de verdade contra a lista de casos. Qualquer outro valor é o
 * motivo escrito de por que a varredura não serve ali — e o motivo tem que
 * nomear onde a prova está, porque "não se aplica" sem endereço é como uma
 * porta some da lista.
 */
const POR_ID = new Map([
  // --- Ids que não são desta casa: vêm do GenieACS, e são iguais para quem
  // apontar dois painéis para o mesmo ACS. Quem os separa é o conector por
  // provedor (Fase 4) e as tabelas escopadas que os indexam.
  ['DELETE /api/devices/faults/:faultId', 'a falha é lida do GenieACS do provedor, não é linha daqui'],
  ['GET /api/devices/:deviceId/history', 'id do aparelho no GenieACS; o histórico é escopado, prova em tenant-leak.test.js'],
  ['GET /api/devices/:deviceId/swaps', 'id do aparelho no GenieACS; device_swaps é escopada, prova em tenant-leak.test.js'],
  ['GET /api/devices/:deviceId/portal-password', 'id do aparelho; a conta do assinante é escopada, prova em tenant-leak.test.js'],
  ['POST /api/devices/:deviceId/portal-password/reset', 'idem, e a redefinição pela conta do vizinho está em tenant-leak.test.js'],
  ['GET /api/devices/:deviceId', 'id do aparelho no GenieACS de cada provedor'],
  ['DELETE /api/devices/:deviceId', 'idem; o que apaga é o aparelho no ACS daquele provedor'],
  ['POST /api/devices/:id/update-wan', 'id do aparelho no GenieACS'],
  ['POST /api/devices/:id/add-wan', 'id do aparelho no GenieACS'],
  ['PUT /api/devices/:id/installation-date', 'id do aparelho; device_profiles é escopada, prova em device-profiles-tenancy.test.js'],
  ['POST /api/devices/:id/update-wifi', 'id do aparelho no GenieACS'],
  ['POST /api/devices/:id/update-credentials', 'id do aparelho no GenieACS'],
  ['GET /api/sgp/devices/:deviceId', 'id do aparelho; sgp_links é escopada, prova em sgp-links-tenancy.test.js'],
  ['POST /api/sgp/devices/:deviceId/link', 'idem — os dois provedores podem vincular o mesmo id, e é o que sgp-links-tenancy.test.js prova'],
  ['DELETE /api/sgp/devices/:deviceId/link', 'idem'],
  ['POST /api/sgp/devices/:deviceId/unlock', 'idem'],
  ['POST /api/sgp/devices/:deviceId/ticket', 'idem'],
  ['GET /api/provisioning/devices/:deviceId/runs', 'id do aparelho; provisioning_runs é escopada, prova em provisioning-tenancy.test.js'],
  ['POST /api/provisioning/devices/:deviceId/preview', 'idem'],
  ['POST /api/provisioning/devices/:deviceId/provision', 'idem'],

  // --- Chaves naturais que os dois provedores têm iguais. Aqui a pergunta não
  // é "o id do vizinho alcança a linha dele?" — o id é o mesmo — e sim "cada um
  // vê a sua". Isso é colisão, e é a suíte de vazamento que responde.
  ['GET /api/settings/:key', 'a chave é a mesma palavra nos dois; cada um lê a sua, prova em tenant-leak.test.js'],
  ['PUT /api/settings/:key', 'idem, e a escrita de um não altera a do outro'],
  ['DELETE /api/settings/:key', 'idem, e o apagar de um não apaga a do outro'],
  ['GET /api/vendor-management/wifi-security-configs/by-product-class/:productClass', 'classe de produto do fabricante, igual nos dois; prova em vendor-catalogue-tenancy.test.js'],
  ['PUT /api/whatsapp/subscribers/:contract/phone', 'o contrato é do SGP e os dois podem tê-lo; prova em tenant-leak.test.js'],
  ['POST /api/whatsapp/contacts/:contract/conversation', 'varredura'],
  ['GET /api/customer/wifi/:index/password', 'índice do rádio no aparelho, não linha; a sessão do portal é escopada, prova em tenant-subdomain.test.js'],

  // --- Anexo servido por token assinado.
  ['GET /api/whatsapp/messages/:id/media', 'prova própria em whatsapp-media-tenancy.test.js, que pede a mídia da mensagem do vizinho'],
  ['GET /api/whatsapp-media/:id', 'idem, pelo token assinado, antes do resolvedor'],

  // --- O plano de controle está ACIMA dos provedores: aqui o id de outro
  // provedor é o trabalho da rota, não um vazamento. O que se prova nessas é
  // que quem não é da plataforma recebe 404.
  ['PATCH /api/platform/tenants/:id', 'plano de controle; o 404 de quem não é da plataforma está em platform-tenants.test.js'],
  ['DELETE /api/platform/tenants/:id', 'plano de controle; prova em platform-tenant-delete.test.js'],
  ['GET /api/platform/tenants/:id/members', 'plano de controle; prova em platform-members.test.js'],
  ['POST /api/platform/tenants/:id/members', 'plano de controle; prova em platform-members.test.js'],
  ['POST /api/platform/tenants/:id/invites', 'plano de controle; prova em platform-members.test.js'],
  ['POST /api/platform/tenants/:id/operators', 'plano de controle; prova em platform-members.test.js'],
  ['DELETE /api/platform/tenants/:id/members/:userId', 'plano de controle; prova em platform-members.test.js'],
  ['PATCH /api/platform/tenants/:id/members/:userId', 'plano de controle; prova em platform-member-edit.test.js'],
  ['POST /api/platform/tenants/:id/members/:userId/password-link', 'plano de controle; prova em platform-member-edit.test.js'],
  ['POST /api/platform/tenants/:id/members/:userId/password', 'plano de controle; prova em platform-member-edit.test.js'],
  ['POST /api/platform/tenants/:id/members/:userId/sessions/revoke', 'plano de controle; prova em platform-member-edit.test.js'],
  // O id aqui não é de linha de provedor nenhum: é o da PESSOA no cadastro do
  // plano de controle, que é tabela compartilhada e não tem `tenant_id` para o
  // vizinho alcançar. O que se prova é o mesmo das outras: quem não está no
  // cadastro recebe 404 — e, junto, que o último não sai.
  ['DELETE /api/platform/admins/:userId', 'plano de controle; prova em platform-admins.test.js'],
  ['PATCH /api/platform/plans/:id', 'plano de controle; prova em platform-billing.test.js'],
  // Tabela da plataforma, sem `tenant_id`: não há vizinho a alcançar.
  ['PATCH /api/platform/leads/:id', 'plano de controle; prova em public-landing.test.js'],
  ['GET /api/platform/tenants/:id/subscription', 'plano de controle; prova em platform-billing.test.js'],
  ['PUT /api/platform/tenants/:id/subscription', 'plano de controle; prova em platform-billing.test.js'],
  ['POST /api/platform/tenants/:id/payments', 'plano de controle; prova em platform-billing.test.js'],
  ['GET /api/platform/tenants/:id/usage', 'plano de controle; prova em platform-billing.test.js'],
  // A tela de Assinaturas. O id do provedor é visto de cima, como nas de
  // cima; o `:chargeId` é linha de tabela ESCOPADA, e a prova de que o do
  // vizinho não alcança a dele (404, lida por `tdb` dentro do escopo do
  // provedor da URL) está no mesmo arquivo.
  ['GET /api/platform/tenants/:id/charges', 'plano de controle; prova em platform-subscriptions.test.js'],
  ['PATCH /api/platform/tenants/:id/subscription/deadlines', 'plano de controle; prova em platform-subscriptions.test.js'],
  ['PUT /api/platform/tenants/:id/subscription/billing-exempt', 'plano de controle; prova em platform-billing-exempt.test.js — inclusive a de que a caixa da plataforma e um id desconhecido respondem 404'],
  // Os cupons (0093): `coupons` é tabela da PLATAFORMA, sem vizinho a
  // alcançar; o `:id` do provedor é visto de cima, e a prova de que o gesto
  // só mexe no provedor da URL está no mesmo arquivo.
  ['PATCH /api/platform/coupons/:id', 'plano de controle, tabela compartilhada; prova em platform-coupons.test.js'],
  ['DELETE /api/platform/coupons/:id', 'plano de controle, tabela compartilhada; prova em platform-coupons.test.js'],
  ['PUT /api/platform/tenants/:id/subscription/coupon', 'plano de controle; prova em platform-coupons.test.js — inclusive a de que a caixa da plataforma responde 404'],
  ['PATCH /api/platform/tenants/:id/charges/:chargeId', 'plano de controle; prova em platform-subscriptions.test.js — inclusive a de que a cobrança do vizinho responde 404'],
  ['POST /api/platform/tenants/:id/charges/:chargeId/settle', 'plano de controle; prova em platform-subscriptions.test.js — inclusive a de que a cobrança do vizinho responde 404'],
  ['POST /api/platform/tenants/:id/charges/:chargeId/cancel', 'plano de controle; prova em platform-subscriptions.test.js — inclusive a de que a cobrança do vizinho responde 404'],
  ['POST /api/platform/tenants/:id/charges/:chargeId/reissue', 'plano de controle; prova em platform-subscriptions.test.js — inclusive a de que a cobrança do vizinho responde 404'],
  ['POST /api/platform/tenants/:id/charges/:chargeId/refund', 'plano de controle; prova em platform-charge-refund.test.js — inclusive a de que a cobrança do vizinho responde 404'],
  ['POST /api/platform/tenants/:id/charges/:chargeId/invoice', 'plano de controle; prova em billing-invoices.test.js — inclusive a de que a cobrança do vizinho responde 404'],
  ['POST /api/platform/tenants/:id/impersonate', 'plano de controle; prova em impersonation.test.js — inclusive a de que a própria personificação não alcança esta rota'],
  // A exportação vista de cima. O id é de um PROVEDOR, e olhá-lo pelo id é o
  // trabalho do console — mas esta é a rota do console que mais se parece com
  // um vazamento, então a prova é mais forte que "404 para id desconhecido":
  // `platform-tenant-export.test.js` exige que o arquivo de um provedor traga
  // as linhas DELE e nenhuma do vizinho.
  ['GET /api/platform/tenants/:id/genieacs', 'plano de controle; prova em platform-managed-settings.test.js'],
  ['PUT /api/platform/tenants/:id/genieacs', 'plano de controle; prova em platform-managed-settings.test.js — inclusive a de que gravar no alfa não toca o beta'],
  ['POST /api/platform/tenants/:id/genieacs/test', 'plano de controle; prova em platform-managed-settings.test.js'],
  ['POST /api/platform/tenants/:id/genieacs/tag-devices', 'plano de controle; prova em shared-acs-scope.test.js — marca só o que não tem dono, nunca o de outro provedor'],
  ['GET /api/platform/tenants/:id/genieacs/firmware/unowned', 'plano de controle; prova em firmware-upload.test.js — lista só o sem dono do ACS daquele provedor'],
  ['POST /api/platform/tenants/:id/genieacs/firmware/reassign', 'plano de controle; prova em firmware-upload.test.js — grava com a tag do provedor da URL, e id que não existe é 404'],
  ['DELETE /api/platform/tenants/:id/genieacs/firmware/unowned/:name', 'plano de controle; prova em firmware-upload.test.js — só apaga arquivo sem dono, nunca o de um provedor'],
  ['POST /api/platform/tenants/:id/genieacs/agent-token', 'plano de controle; prova em genieacs-agent-saas.test.js — a chave vai só para o provedor pedido, e id que não existe é 404'],
  ['GET /api/platform/tenants/:id/export', 'plano de controle; prova em platform-tenant-export.test.js — inclusive a de que o arquivo de um não traz linha do outro'],
  ['POST /api/platform/tenants/:id/gateway/asaas-customer', 'plano de controle; prova em platform-integrations.test.js — inclusive o 404 da caixa da plataforma e de quem não existe'],
  // A indicação e os créditos (0106): provedor visto de cima; a prova de que o
  // crédito de um não aparece nem é abatido no outro está no mesmo arquivo.
  ['GET /api/platform/tenants/:id/referrals', 'plano de controle; prova em referrals.test.js — inclusive o 404 da caixa da plataforma'],
  ['POST /api/platform/tenants/:id/credits', 'plano de controle; prova em referrals.test.js — o ajuste fica no provedor da URL, e a caixa da plataforma é 404'],
  ['DELETE /api/platform/tenants/:id/subscription/cancellation', 'plano de controle; prova em cancellation-retention.test.js — desfaz só o do provedor da URL, e a caixa da plataforma responde 404']
]);

// Todo caso da varredura entra aqui sozinho: a lista dela é a fonte, e repetir
// os rótulos à mão seria a mesma coisa escrita duas vezes.
for (const caso of casos) POR_ID.set(caso.label, 'varredura');

const rotas = listRoutes();
const chave = (r) => `${r.method} ${r.path}`;

describe('o inventário de rotas', () => {
  it('encontra as rotas dos dois listeners', () => {
    // Um número redondo demais seria um teste que ninguém entende quando
    // quebra: o que se exige é que os dois apps tenham sido varridos e que o
    // total seja grande o bastante para não ser um parser que achou meia dúzia.
    const painel = rotas.filter((r) => r.app === 'app');
    const portal = rotas.filter((r) => r.app === 'portalApp');
    assert.ok(painel.length > 100, `poucas rotas de painel: ${painel.length}`);
    assert.ok(portal.length >= 8, `poucas rotas de portal: ${portal.length}`);
    for (const r of rotas) {
      assert.match(r.path, /^\/api\//, `rota fora de /api: ${chave(r)}`);
      assert.ok(r.handlers.length > 0, `rota sem handler: ${chave(r)}`);
    }
  });
});

describe('toda rota sem sessão', () => {
  const semSessao = rotas.filter((r) => !r.handlers.some((h) => GUARDAS_DE_SESSAO.has(h)));

  it('está declarada, com o motivo escrito', () => {
    const naoDeclaradas = semSessao.map(chave).filter((k) => !PUBLICAS.has(k));
    assert.deepEqual(naoDeclaradas, [],
      'rota nova sem guarda de sessão: feche a porta ou declare-a em PUBLICAS com o motivo');
  });

  it('e nenhuma declaração sobrou de uma rota que não existe mais', () => {
    const atuais = new Set(semSessao.map(chave));
    const orfas = [...PUBLICAS.keys()].filter((k) => !atuais.has(k));
    assert.deepEqual(orfas, [], 'entrada em PUBLICAS sem rota correspondente');
  });

  it('não é nenhuma que escreva no cadastro de outro provedor', () => {
    // As de escrita entre as públicas são exatamente estas, e a lista existe
    // para que uma sexta chame a atenção de quem revisa.
    const escritas = semSessao
      .filter((r) => r.method !== 'GET')
      .map(chave)
      .sort();
    assert.deepEqual(escritas, [
      // A confirmação do endereço: escreve o carimbo em `users`, que é cadastro
      // compartilhado, e só na conta que o bilhete nomeia.
      'POST /api/auth/email/verify/confirm',
      // O bilhete de personificação: escreve, sim — marca o bilhete como
      // usado —, e é escrita no cadastro COMPARTILHADO, nunca no de um
      // provedor. Quem a autoriza é o bilhete, cunhado pelo console.
      'POST /api/auth/impersonate/redeem',
      'POST /api/auth/login',
      // As duas metades do "esqueci minha senha". A primeira escreve uma linha
      // na trilha DO PROVEDOR do host — e só depois de conferir que a pessoa
      // trabalha nele. A segunda escreve a senha em `users`, que é cadastro
      // compartilhado, e só para a conta que o bilhete nomeia.
      'POST /api/auth/password-reset',
      'POST /api/auth/password-reset/confirm',
      'POST /api/auth/refresh',
      'POST /api/auth/setup',
      'POST /api/auth/signup',
      // A entrega do gateway é a terceira escrita pública que não vem de um
      // navegador. Escreve no extrato e na assinatura de UM provedor, e o
      // provedor sai do corpo — nunca do host, que não o nomeia. O que a separa
      // das outras duas é que esta mexe em dinheiro: a credencial é do deploy,
      // a rota não existe sem ela configurada, e a mesma referência credita uma
      // vez só.
      'POST /api/billing-webhook',
      'POST /api/customer/login',
      // O cadastro de um indicado pelo link de um cliente. Escreve uma linha em
      // `customer_referrals` do provedor que o token assinado nomeia — o
      // token é conferido por HMAC e pelo host antes de abrir o escopo.
      'POST /api/customer/referral',
      'POST /api/invites/token/accept',
      // A prévia do convite NÃO escreve nada: ela é POST só porque o token
      // saiu do caminho e foi para o corpo, para não acabar no log do
      // servidor, que grava o caminho inteiro. Aparece nesta lista porque a
      // lista pergunta pelo MÉTODO, que é o recorte certo para ela — e a
      // exceção fica escrita aqui em vez de a pergunta ser afrouxada.
      'POST /api/invites/token/preview',
      // O pedido de demonstração da página pública. Só INSERE em `leads`, que
      // é tabela da plataforma, sem `tenant_id` — não há cadastro de provedor
      // nenhum ao alcance dela.
      'POST /api/public/leads',
      'POST /api/sgp/events/webhook',
      'POST /api/whatsapp-webhook'
    ]);
  });
});

describe('toda rota endereçada por um parâmetro', () => {
  const comParametro = rotas.filter((r) => /:/.test(r.path));

  it('tem quem prove que o parâmetro do vizinho não alcança a linha dele', () => {
    const semProva = comParametro.map(chave).filter((k) => !POR_ID.has(k));
    assert.deepEqual(semProva, [],
      'rota nova endereçada por id: ponha-a na varredura ou declare em POR_ID onde está a prova');
  });

  it('e nenhuma declaração sobrou de uma rota que não existe mais', () => {
    const atuais = new Set(comParametro.map(chave));
    const orfas = [...POR_ID.keys()].filter((k) => !atuais.has(k));
    assert.deepEqual(orfas, [], 'entrada em POR_ID sem rota correspondente');
  });

  // Um teto, não uma meta. Declarar motivo é mais fácil do que escrever caso, e
  // sem esta linha o caminho fácil não custa nada — baixar o teto junto com uma
  // exceção nova é o pedágio de quem toma esse caminho, e é o que faz alguém
  // pensar duas vezes.
  //
  // **O teto subiu de 41 para 42, e é a primeira vez.** Vale registrar por quê,
  // porque a regra original dizia que o número só podia cair e isso deixou de
  // ser verdade aqui. A rota nova é `DELETE /api/platform/admins/:userId`: o id
  // é de uma PESSOA no cadastro do plano de controle, tabela compartilhada, sem
  // `tenant_id` para o vizinho alcançar. O pedágio era escrever um caso na
  // varredura, e a varredura prova vazamento ENTRE PROVEDORES — não há caso a
  // escrever, porque não há provedor nenhum nesta rota. Pagar noutra moeda
  // (converter uma exceção alheia) seria empurrar trabalho sem relação nenhuma
  // para dentro desta mudança.
  //
  // O que fecha a porta que isso abriria está logo abaixo: as exceções do
  // console passam a ser contadas à parte, e o número que de fato importa — o
  // das rotas endereçadas por id de LINHA DE PROVEDOR — continua só podendo
  // cair. Uma rota nova do console custa uma linha em `DO_CONSOLE`, onde
  // qualquer um a vê; uma rota nova de provedor continua custando um caso.
  //
  // As 42 de hoje são, todas: id de aparelho no GenieACS (20), chave natural
  // que os dois provedores têm igual (7), anexo por token assinado (2), token
  // de convite (2) e o plano de controle (11).
  // Caiu de 42 para 40 quando o token do convite saiu do CAMINHO e foi para o
  // corpo: as duas rotas deixaram de ser endereçadas por parâmetro, então
  // saíram do alcance desta conta em vez de precisarem de exceção. O número só
  // pode cair.
  //
  // E subiu de 40 para 41 com `POST /api/platform/tenants/:id/invites`, e de 41
  // para 42 com `POST /api/platform/tenants/:id/operators` — as duas do
  // console, e cada uma pagando o mesmo pedágio: uma linha em `DO_CONSOLE` e
  // mais uma aqui. As 42 de agora: aparelho (20), chave natural (7), anexo por
  // token (2) e o console (13). O número que de fato importa,
  // `TETO_FORA_DO_CONSOLE`, não se move.
  // E de 42 para 43 com `GET /api/platform/tenants/:id/export`, pagando o mesmo
  // pedágio das duas acima: uma linha em `DO_CONSOLE` e mais uma aqui. Ela é a
  // rota do console que mais se parece com o que a varredura persegue — um id
  // de provedor na URL devolvendo as linhas daquele provedor —, e por isso a
  // prova dela não é só o 404: o teste exige que o arquivo de um traga as
  // linhas dele e nenhuma do vizinho, que é a varredura feita à mão para o
  // único caso em que devolver a linha do outro seria o trabalho e não o
  // vazamento. As 43 de agora: aparelho (20), chave natural (7), anexo por
  // token (2) e o console (14). `TETO_FORA_DO_CONSOLE` não se move.
  //
  // E as três do GenieACS de um provedor configurado do console
  // (`/tenants/:id/genieacs`), que pagam o mesmo pedágio: na SaaS é a
  // plataforma quem diz para onde o painel de cada provedor fala, e olhar o
  // provedor pelo id é o trabalho. A prova de que gravar no alfa não toca o
  // beta está em platform-managed-settings.test.js. São 46.
  //
  // E a quarta, `/tenants/:id/genieacs/tag-devices`: a plataforma marcando com
  // a tag de um provedor os equipamentos sem dono de um ACS compartilhado. A
  // prova de que ela não toma equipamento de outro provedor está em
  // shared-acs-scope.test.js. São 47.
  //
  // E as quatro da conta de um membro da equipe no console (editar, link de
  // senha, senha na hora, encerrar sessões), pelo mesmo pedágio das de
  // `members/:userId`: a prova de que o id de outro provedor responde 404 está
  // em platform-member-edit.test.js.
  // São 51.
  //
  // E `POST /tenants/:id/gateway/asaas-customer`: o console criando o provedor
  // como cliente na conta Asaas da plataforma. O id é de provedor visto de
  // cima, pelo mesmo pedágio — uma linha em `DO_CONSOLE` e mais uma aqui. A
  // prova (404 para a caixa e para quem não existe, 409 para quem já está
  // ligado) está em platform-integrations.test.js. São 52.
  //
  // E `POST /tenants/:id/genieacs/agent-token`: o console gerando a chave do
  // agente do GenieACS de um provedor (modo `agent`). Mesmo pedágio — uma
  // linha em `DO_CONSOLE` e mais uma aqui; a prova de que a chave vai só para
  // o provedor pedido está em genieacs-agent-saas.test.js. São 53.
  //
  // E as seis da tela de Assinaturas do console (as cobranças de um provedor,
  // o prazo mexido à mão, e baixa, cancelamento, mudança e reemissão de uma
  // cobrança). Mesmo pedágio, seis vezes: seis linhas em `DO_CONSOLE` e seis
  // aqui. O `:chargeId` é linha de tabela escopada, e por isso a prova vai
  // além do 404 de quem não é da plataforma: platform-subscriptions.test.js
  // pede, pela URL do alfa, a cobrança do beta — e recebe 404. São 59.
  //
  // E o estorno de uma cobrança paga (`POST .../charges/:chargeId/refund`),
  // da mesma tela e pelo mesmo pedágio: uma linha em `DO_CONSOLE` e mais uma
  // aqui. A prova de que a cobrança do vizinho responde 404 está em
  // platform-charge-refund.test.js.
  // E os pedidos de demonstração (`PATCH /api/platform/leads/:id`): tabela da
  // plataforma, sem vizinho a alcançar. São 61.
  //
  // E o "isento de cobrança" (`PUT .../subscription/billing-exempt`), o
  // interruptor do painel Plano e da tela de Assinaturas. Mesmo pedágio: uma
  // linha em `DO_CONSOLE` e mais uma aqui. O id é de PROVEDOR visto de cima, e
  // a prova de que o gesto só mexe no provedor da URL (e de que a caixa da
  // plataforma responde 404) está em platform-billing-exempt.test.js. São 62.
  //
  // E a NFS-e de uma cobrança paga (`POST .../charges/:chargeId/invoice`),
  // pedida da tela de Assinaturas e do Extrato. Mesmo pedágio: uma linha em
  // `DO_CONSOLE` e mais uma aqui; a prova de que a cobrança do vizinho
  // responde 404 está em billing-invoices.test.js. São 63.
  // E os cupons de desconto (0093): o `PATCH` e o `DELETE` de
  // `/coupons/:id` (tabela da plataforma, como `plans`) e o
  // `PUT .../subscription/coupon` (provedor visto de cima). Três linhas em
  // `DO_CONSOLE` e três aqui; prova em platform-coupons.test.js. Somados à NFS-e, são 66.
  //
  // E as três dos firmwares SEM dono de um GenieACS compartilhado (listar,
  // reenviar como do provedor, apagar o antigo). O id é de provedor visto de
  // cima, e o `:name` é arquivo do GenieACS, não linha de tabela nenhuma. Mesmo
  // pedágio: três linhas em `DO_CONSOLE` e três aqui; prova em
  // firmware-upload.test.js. São 69. (O apagar do PROVEDOR leva o nome na
  // query, e por isso não entra nesta conta.)
  //
  // E as duas da indicação de provedores (0106): a lista de indicações e
  // créditos de um provedor e o ajuste manual do saldo. Provedor visto de
  // cima; duas linhas em `DO_CONSOLE` e duas aqui; prova em
  // referrals.test.js. São 71.
  //
  // E o desfazer do cancelamento agendado de um provedor pelo console
  // (`DELETE .../subscription/cancellation`, 0107). Mesmo pedágio: uma linha
  // em `DO_CONSOLE` e mais uma aqui; a prova de que só mexe no provedor da URL
  // está em cancellation-retention.test.js. São 72.
  const TETO_DE_EXCECOES = 72;


  /**
   * As exceções que são do plano de controle, nomeadas uma a uma.
   *
   * Estão aqui, e não numa contagem, para que acrescentar uma seja um ato
   * visível: quem lê a lista vê exatamente quais rotas do console não passam
   * pela varredura, e por que nenhuma delas poderia passar — todas são
   * endereçadas por id de tabela compartilhada (`plans`, `users`,
   * `platform_admins`) ou por id de provedor visto de CIMA, que é o único
   * lugar do produto onde olhar o provedor pelo id é o trabalho e não o
   * vazamento.
   */
  const DO_CONSOLE = new Set([
    'DELETE /api/platform/tenants/:id',
    'PATCH /api/platform/tenants/:id',
    'POST /api/platform/tenants/:id/impersonate',
    'GET /api/platform/tenants/:id/members',
    'POST /api/platform/tenants/:id/members',
    'POST /api/platform/tenants/:id/invites',
    'POST /api/platform/tenants/:id/operators',
    'DELETE /api/platform/tenants/:id/members/:userId',
    'PATCH /api/platform/tenants/:id/members/:userId',
    'POST /api/platform/tenants/:id/members/:userId/password-link',
    'POST /api/platform/tenants/:id/members/:userId/password',
    'POST /api/platform/tenants/:id/members/:userId/sessions/revoke',
    'DELETE /api/platform/admins/:userId',
    'PATCH /api/platform/plans/:id',
    'GET /api/platform/tenants/:id/subscription',
    'PUT /api/platform/tenants/:id/subscription',
    'POST /api/platform/tenants/:id/payments',
    'GET /api/platform/tenants/:id/usage',
    'GET /api/platform/tenants/:id/charges',
    'PATCH /api/platform/tenants/:id/subscription/deadlines',
    'PUT /api/platform/tenants/:id/subscription/billing-exempt',
    'PATCH /api/platform/coupons/:id',
    'DELETE /api/platform/coupons/:id',
    'PUT /api/platform/tenants/:id/subscription/coupon',
    'PATCH /api/platform/tenants/:id/charges/:chargeId',
    'POST /api/platform/tenants/:id/charges/:chargeId/settle',
    'POST /api/platform/tenants/:id/charges/:chargeId/cancel',
    'POST /api/platform/tenants/:id/charges/:chargeId/reissue',
    'POST /api/platform/tenants/:id/charges/:chargeId/refund',
    'POST /api/platform/tenants/:id/charges/:chargeId/invoice',
    'GET /api/platform/tenants/:id/export',
    'GET /api/platform/tenants/:id/genieacs',
    'PUT /api/platform/tenants/:id/genieacs',
    'POST /api/platform/tenants/:id/genieacs/test',
    'POST /api/platform/tenants/:id/genieacs/tag-devices',
    'GET /api/platform/tenants/:id/genieacs/firmware/unowned',
    'POST /api/platform/tenants/:id/genieacs/firmware/reassign',
    'DELETE /api/platform/tenants/:id/genieacs/firmware/unowned/:name',
    'POST /api/platform/tenants/:id/genieacs/agent-token',
    'POST /api/platform/tenants/:id/gateway/asaas-customer',
    'GET /api/platform/tenants/:id/referrals',
    'POST /api/platform/tenants/:id/credits',
    'DELETE /api/platform/tenants/:id/subscription/cancellation'
  ]);

  // Este é o número que guarda o que a varredura existe para guardar, e ELE só
  // pode cair. Uma rota nova endereçada por id de linha de provedor não tem
  // como ser declarada sem alguém derrubar outra — que era a intenção desde o
  // começo.
  const TETO_FORA_DO_CONSOLE = 30;

  it('deixa de fora só as que têm motivo, e não mais do que hoje', () => {
    const naoVarridas = comParametro
      .filter((r) => POR_ID.get(chave(r)) !== 'varredura')
      .map(chave);
    assert.ok(naoVarridas.length <= TETO_DE_EXCECOES,
      `${naoVarridas.length} rotas com id fora da varredura, e o teto é ${TETO_DE_EXCECOES}:\n  ${naoVarridas.join('\n  ')}`);
  });

  it('e as que não são do console não passam do teto delas, que só cai', () => {
    const foraDoConsole = comParametro
      .filter((r) => POR_ID.get(chave(r)) !== 'varredura')
      .map(chave)
      .filter((k) => !DO_CONSOLE.has(k));
    assert.ok(foraDoConsole.length <= TETO_FORA_DO_CONSOLE,
      `${foraDoConsole.length} rotas de provedor com id fora da varredura, e o teto é `
      + `${TETO_FORA_DO_CONSOLE}. Escreva o caso na varredura, ou derrube outra exceção `
      + `para abrir espaço:\n  ${foraDoConsole.join('\n  ')}`);
  });

  it('e a lista do console não guarda rota que não existe mais', () => {
    const atuais = new Set(comParametro.map(chave));
    const orfas = [...DO_CONSOLE].filter((k) => !atuais.has(k));
    assert.deepEqual(orfas, [], 'entrada em DO_CONSOLE sem rota correspondente');
  });
});

describe('a varredura de ids', () => {
  it('não tem caso apontando para rota que não existe', () => {
    const atuais = new Set(rotas.map(chave));
    const fantasmas = casos.map((c) => c.label).filter((l) => !atuais.has(l));
    assert.deepEqual(fantasmas, [], 'caso da varredura sem rota correspondente');
  });

  /**
   * A conta que faltava: uma rota pode DIZER que a varredura a cobre sem que
   * exista caso nenhum para ela.
   *
   * A conta que já havia ia só no sentido fácil — caso sem rota. O outro
   * sentido é o que dá para errar sem perceber: acrescentar a rota, escrever
   * `'varredura'` ao lado dela e seguir em frente, com a declaração parecendo
   * prova sem ser prova de nada. Nenhuma rota estava assim quando esta linha
   * entrou, e é justamente por isso que ela entra agora: uma conta escrita
   * enquanto o número está certo é uma conta que ninguém precisa acreditar.
   */
  it('cobre de fato toda rota que se declara varrida', () => {
    const rotulos = new Set(casos.map((c) => c.label));
    const prometidas = [...POR_ID.entries()]
      .filter(([, motivo]) => motivo === 'varredura')
      .map(([rota]) => rota)
      .filter((rota) => !rotulos.has(rota));
    assert.deepEqual(prometidas, [],
      'rota declarada como varrida sem caso correspondente em tenant-id-sweep.test.js');
  });

  it('não tem dois casos com o mesmo rótulo', () => {
    const vistos = new Set();
    const repetidos = [];
    for (const caso of casos) {
      if (vistos.has(caso.label)) repetidos.push(caso.label);
      vistos.add(caso.label);
    }
    assert.deepEqual(repetidos, []);
  });

  it('diz de que tabela é cada caso, e a tabela é escopada', async () => {
    const { SCOPED_TABLES } = await import('../src/config/tenantScope.js');
    for (const caso of casos) {
      assert.ok(caso.tabela, `${caso.label}: sem tabela`);
      assert.ok(caso.chave, `${caso.label}: sem chave de seed`);
      // `users` é do deploy e não do provedor: quem responde 404 ali é o
      // vínculo em `tenant_users`, com prova própria em users-tenancy.test.js.
      if (caso.tabela === 'users') continue;
      assert.ok(SCOPED_TABLES.has(caso.tabela),
        `${caso.label}: ${caso.tabela} não está na lista de tabelas escopadas`);
    }
  });
});

describe('cada prova nomeada em uma declaração', () => {
  it('é um arquivo de teste que existe', () => {
    const citados = new Set();
    for (const motivo of [...POR_ID.values(), ...PUBLICAS.values()]) {
      for (const m of String(motivo).matchAll(/([a-z0-9-]+\.test\.js)/g)) citados.add(m[1]);
    }
    assert.ok(citados.size >= 8, `poucas provas citadas: ${citados.size}`);
    for (const arquivo of citados) {
      assert.ok(fs.existsSync(path.join(RAIZ, 'test', arquivo)),
        `a declaração cita ${arquivo}, que não existe`);
    }
  });
});

/**
 * A superfície do endereço da plataforma, lida da fonte.
 *
 * O ápice não pertence a provedor nenhum: `resolveTenant` o deixa passar SEM
 * escopo, então qualquer coisa servida ali que leia dado de provedor estoura
 * no sentinela — ou, pior, serve o provedor que o token nomear pelo endereço
 * da plataforma. A allowlist é o que separa uma coisa da outra, e ela cresce
 * por descuido: alguém acrescenta um caminho para uma tela funcionar no ápice
 * e o escopo não é a primeira coisa em que pensa.
 *
 * Daí um teste de FONTE e não de comportamento: o que se quer fixar não é o
 * que cada caminho responde, é o que a lista tem direito de conter. Um prefixo
 * é a permissão mais larga, então a regra é mais estreita: só famílias que
 * nomeiam o provedor no próprio caminho.
 */
describe('a allowlist do endereço da plataforma', () => {
  const fonte = fs.readFileSync(path.join(RAIZ, 'src', 'middleware', 'tenantResolver.js'), 'utf8');
  const listaDe = (nome) => {
    const bloco = new RegExp(`const ${nome} = [^;]+;`).exec(fonte);
    assert.ok(bloco, `${nome} não encontrada em tenantResolver.js`);
    return [...bloco[0].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };

  // Os dois arquivos do agente entraram de propósito: o console gera a chave
  // de um provedor no ápice e mostra o comando de instalação com a origem de
  // lá. Não leem dado de provedor nenhum — são dois arquivos do disco —, e a
  // origem que o instalador leva no ápice é o domínio-base configurado, nunca o
  // Host (prova em genieacs-agent-files-subdomain.test.js).
  it('serve por caminho exato só o perfil público, o cadastro e os arquivos do agente', () => {
    assert.deepEqual(listaDe('PLATFORM_HOST_PATHS').sort(), [
      '/api/auth/signup',
      '/api/genieacs-agent/agent.mjs',
      '/api/genieacs-agent/install.sh',
      '/api/tenant/public'
    ]);
  });

  it('acrescenta a porta do console, e só ela', () => {
    assert.deepEqual(listaDe('CONSOLE_HOST_PATHS').sort(), [
      '/api/auth/change-password',
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/refresh',
      '/api/auth/setup-status',
      '/api/auth/user'
    ]);
  });

  /**
   * O que NÃO pode entrar, e o teste é sobre a razão: estes caminhos gravam na
   * trilha DO PROVEDOR ou montam endereço a partir de `req.tenantId`, e no
   * ápice não há provedor em escopo — a leitura escopada estouraria. Quem
   * precisar de redefinição de senha para uma conta de plataforma usa
   * `scripts/reset-password.js`, que roda sem escopo.
   */
  it('não serve os caminhos que escrevem na trilha de um provedor', () => {
    const lista = [...listaDe('PLATFORM_HOST_PATHS'), ...listaDe('CONSOLE_HOST_PATHS')];
    for (const proibido of [
      '/api/auth/password-reset',
      '/api/auth/password-reset/confirm',
      '/api/auth/email',
      '/api/auth/email/verify',
      '/api/auth/email/verify/confirm',
      '/api/auth/setup',
      '/api/auth/impersonate/redeem'
    ]) {
      assert.ok(!lista.includes(proibido), `${proibido} entrou na allowlist do ápice`);
    }
  });

  it('serve por prefixo só a família do plano de controle', () => {
    // `/api/auth/` nunca: a redefinição de senha e a verificação de e-mail
    // gravam na trilha DO PROVEDOR, e no ápice não há escopo em que gravar.
    // `/api/public/` é a página pública: catálogo, subdomínio livre, CNPJ e
    // pedido de demonstração — nenhuma grava em trilha de provedor.
    assert.deepEqual(listaDe('PLATFORM_HOST_PREFIXES'), ['/api/platform/', '/api/public/']);
  });
});

describe('a ordem das montagens em app.js', () => {
  const fonte = fs.readFileSync(path.join(RAIZ, 'src', 'app.js'), 'utf8');
  const linhas = fonte.split('\n');
  const indiceDe = (regex) => linhas.findIndex((l) => regex.test(l));

  it('põe o resolvedor de provedor antes de todo roteador', () => {
    const resolvedor = indiceDe(/^app\.use\('\/api', resolveTenant\);/);
    assert.ok(resolvedor > 0, 'o resolvedor não está montado em /api');

    // Um roteador montado ACIMA desta linha atende sem provedor em escopo. É a
    // falha que o comentário do `/api/tenant` no próprio app.js descreve, e o
    // teste existe para que ela não volte por uma linha no lugar errado.
    // A constante conta como montagem, e tem que contar: o prefixo do webhook
    // virou `WA_WEBHOOK_PATH` para que o caminho atendido e o endereço público
    // conferido saiam do mesmo lugar. Lendo só literais, um roteador montado
    // por constante acima do resolvedor passaria despercebido — que é
    // exatamente o ponto cego que este teste existe para não ter.
    const montagens = linhas
      .map((l, i) => ({ i, l }))
      .filter(({ l }) => /^\s*app\.use\((?:'\/api\/[^']*'|[A-Z][A-Z0-9_]*),\s*\w+Routes\);/.test(l));
    assert.ok(montagens.length > 10, 'poucas montagens encontradas');
    const acima = montagens.filter(({ i }) => i < resolvedor).map(({ l }) => l.trim());
    assert.deepEqual(acima, [
      // As três exceções, e as três são entregas de fora que trazem o provedor
      // no próprio corpo ou no token assinado.
      'app.use(WA_WEBHOOK_PATH, whatsappWebhookRoutes);',
      // A do gateway chega no endereço que a plataforma digitou no painel DELE
      // — o apex —, e o apex não nomeia provedor nenhum: resolvida por host,
      // ela levaria 404 antes do controlador e o pagamento de um cliente
      // ficaria na fila de reentrega do gateway até alguém reparar.
      'app.use(BILLING_WEBHOOK_PATH, billingWebhookRoutes);',
      "app.use('/api/whatsapp-media', whatsappMediaRoutes);"
    ]);
  });

  /**
   * A porta da assinatura NÃO é montada aqui, e a ausência é a invariante.
   *
   * Ela já foi um `app.use('/api', …)` logo depois do resolvedor. Nessa
   * posição responde antes do 401, e aí um request sem token nenhum devolve
   * 402 num provedor inadimplente e 401 num em dia — a fatura de um ISP vira
   * fato consultável por quem alcançar o host. Hoje é chamada de dentro de
   * `authenticateToken` e de `authenticatePortalCustomer`, o que garante a
   * ordem por construção.
   *
   * Este teste existe para o dia em que alguém a montar de volta "para a tela
   * de bloqueio aparecer antes do login": aparece, e leva a fatura junto.
   */
  it('não monta a porta da assinatura acima das rotas, em listener nenhum', () => {
    assert.ok(
      !/app\.use\([^)]*requireActiveSubscription/.test(fonte),
      'a porta da assinatura voltou para cima do 401 — ver subscriptionGate.js'
    );
    assert.ok(
      !/subscriptionRefusal/.test(fonte),
      'a porta da assinatura não se resolve em app.js; ela é chamada pela autenticação'
    );
  });

  it('e a autenticação é quem a chama, nos dois listeners', () => {
    const painel = fs.readFileSync(path.join(RAIZ, 'src', 'middleware', 'auth.js'), 'utf8');
    const portal = fs.readFileSync(path.join(RAIZ, 'src', 'middleware', 'portalAuth.js'), 'utf8');
    assert.match(painel, /subscriptionRefusal\(req\)/, 'o painel deixou de consultar a porta');
    assert.match(portal, /subscriptionRefusal\(req, \{ portal: true \}\)/, 'o portal deixou de consultar a porta');
  });

  it('não monta a troca de banco nem o console fora da sua edição', () => {
    assert.match(fonte, /if \(IS_SELF_HOSTED\) \{\n\s*app\.use\('\/api\/database', databaseRoutes\);/);
    assert.match(fonte, /if \(IS_SAAS\) \{[\s\S]*app\.use\('\/api\/platform', platformRoutes\);/);
  });
});

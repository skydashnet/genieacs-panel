import fs from 'node:fs/promises';
import Tenant from '../models/Tenant.js';
import { providerFor, PROVEDORES } from '../services/billing/registry.js';
import ImpersonationTicket from '../models/ImpersonationTicket.js';
import { panelBaseDomain, portalBaseDomain, usesTenantSubdomains } from '../middleware/tenantResolver.js';
import { EDITION } from '../config/edition.js';
import { resolveClient } from '../config/dbConfig.js';
import { rlsEnabled } from '../config/rls.js';
import { mailConfigured } from '../services/mail/index.js';
import { readPublic as readAsaasSettings } from '../services/billing/asaasSettingsService.js';
import { METRICS_CONTENT_TYPE, renderMetrics } from '../utils/metrics.js';
import Subscription from '../models/Subscription.js';
import SubscriptionService from '../services/subscriptionService.js';
import TenantExportService from '../services/tenantExportService.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { SCHEMA_TABLES } from '../config/migrations.js';
import { SCOPED_TABLES } from '../config/tenantScope.js';
import { forgetResolvedTenant } from '../middleware/tenantResolver.js';
import AuditLog from '../models/AuditLog.js';
import { runInTenant } from '../config/tenantContext.js';
import { getDb } from '../config/database.js';
import { catalogueSizes, catalogueSource, propagateCatalogue, seedDefaults } from '../config/seed.js';
import Vendor from '../models/Vendor.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { slugProblem } from '../utils/slug.js';
import { tenantMediaRoot } from '../services/waMediaService.js';

const NAME_MAX_LENGTH = 128;

/**
 * The provider registry: create, list, corrigir o cadastro, suspend, reactivate
 * — e, desde a onda 22, apagar.
 *
 * A versão anterior deste comentário dizia que apagar não existia, e o
 * argumento continua inteiro: apagar leva os aparelhos, os assinantes e o
 * histórico de mensagens de um ISP junto, e um botão que faz isso num clique
 * não deveria existir. O que mudou não foi o argumento, foi a exigência: LGPD
 * dá ao titular o direito de sumir, e um contrato cancelado precisa de um fim.
 *
 * A conciliação está na forma da operação, não na sua ausência. Apagar exige
 * **quatro** coisas ao mesmo tempo, e nenhuma delas acontece por acidente:
 *
 * 1. estar no plano de controle;
 * 2. o provedor estar **suspenso** — o que faz da exclusão um segundo passo,
 *    com um estado reversível no meio, e não um clique;
 * 3. o slug digitado de volta, exato;
 * 4. não ser o último provedor do deployment.
 *
 * E a linha da trilha da plataforma é gravada ANTES, com a contagem do que vai
 * sumir: se ela não puder ser gravada, não se apaga. Apagar sem deixar rastro é
 * a única forma de apagar que é indefensável.
 */

/** The only two values `tenants.status` is allowed to take. */
export const TENANT_STATUSES = Object.freeze(['active', 'suspended']);


/**
 * The provider as the console shows it: `operators` is how many people work
 * there, `subscription` is the plan and the state it is in (null only for a
 * provider the 0034 backfill somehow missed, which the seed repairs at boot).
 */
function present(tenant, operators, subscription = null) {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    // O console vê o cadastro fiscal porque é quem fatura. Quem o EDITA é o
    // próprio provedor, pela tela de plano — o console não tem formulário para
    // isso, de propósito: um dado que o cliente mantém é um dado que ele
    // corrige sozinho quando muda de endereço.
    billing: Tenant.presentBilling(tenant),
    // A correlação com o gateway, que o console escreve e o webhook lê.
    gateway: Tenant.presentGateway(tenant),
    operators,
    subscription: subscription ? {
      status: SubscriptionService.effectiveStatus(subscription).status,
      storedStatus: subscription.status,
      planId: subscription.plan_id,
      planCode: subscription.plan_code ?? null,
      planName: subscription.plan_name ?? null,
      trialEndsAt: subscription.trial_ends_at ?? null,
      renewsAt: subscription.renews_at ?? null
    } : null,
    createdAt: tenant.created_at ?? null,
    // Desde quando está suspenso — e `null` é resposta, não ausência: ou o
    // provedor está ativo, ou foi suspenso antes de a coluna existir e a trilha
    // não guardou. A tela distingue os dois pelo `status`, e não inventa data
    // para nenhum dos casos.
    suspendedAt: tenant.suspended_at ?? null
  };
}

/** One query for every provider's subscription, keyed by provider id. */
async function subscriptionsByTenant() {
  const rows = await Subscription.listWithPlans();
  return new Map(rows.map((row) => [Number(row.tenant_id), row]));
}

class PlatformController {
  /**
   * `POST /api/platform/tenants/:id/impersonate` — olhar o painel de um cliente.
   *
   * O que sai daqui é um BILHETE, não uma sessão. O console recebe um valor
   * opaco de uso único e um endereço, e manda o navegador para lá com o
   * bilhete no fragmento — a parte da URL que nunca chega a servidor nenhum. É
   * o painel do provedor, no host dele, que troca o bilhete pelo token, e o
   * token nasce e morre naquele origin. As alternativas todas são piores: um
   * JWT no query string entra em log de proxy e em histórico; um cookie no
   * domínio-pai desfaz a garantia host-only que a Fase 2 conquistou.
   *
   * A sessão que o bilhete vai produzir entra como `admin` e pode escrever;
   * cada escrita fica na trilha do provedor assinada pela plataforma. Só as
   * rotas da conta ficam de fora — ver `impersonationRefusal` em
   * `middleware/auth.js`.
   *
   * Escrita aqui em `platform_audit`, que é a nossa trilha: registra quem
   * pediu para olhar o painel de quem. Que a sessão tenha realmente começado
   * é outra pergunta, e a resposta dela vive no `audit_log` DO PROVEDOR,
   * escrita no resgate — porque quem faz essa pergunta é o ISP, e ele não lê a
   * nossa trilha.
   */
  static async impersonate(req, res) {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      const { token } = await ImpersonationTicket.create({
        tenantId: tenant.id,
        platformUserId: req.user.userId
      });

      await PlatformAudit.record({
        action: PlatformAudit.ACTIONS.TENANT_IMPERSONATED,
        actorUserId: req.user.userId,
        actorUsername: req.user.username,
        tenant,
        ip: req.ip ?? null
      });

      // Sem domínio-base o console e o painel dividem o mesmo endereço, então
      // o caminho relativo é o certo — e é o que a instalação self-hosted vê.
      const base = panelBaseDomain();
      const url = base
        ? `https://${tenant.slug}.${base}/impersonate#${token}`
        : `/impersonate#${token}`;

      return res.json(createResponse('Impersonation ticket minted', {
        tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
        url,
        expiresInSeconds: Math.round(ImpersonationTicket.TTL_MS / 1000)
      }));
    } catch (error) {
      console.error('Impersonate error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to mint the impersonation ticket', error.message)
      );
    }
  }

  /**
   * `GET /api/platform/deployment` — os fatos do DEPLOY, que não são de
   * provedor nenhum e até agora só se descobriam por ssh.
   *
   * É a metade da Configuração que faltava no console. As dez abas de
   * Configuração do painel são de um ISP — o ACS dele, o ERP dele, a conexão
   * de WhatsApp dele. Isto aqui é a outra metade: em que edição o processo
   * está, contra que banco, em que endereços atende, e o que está ou não
   * configurado. É o que responde "por que o convite não chegou" sem ninguém
   * abrir um terminal.
   *
   * **Só leitura, e configurado sim/não em vez do valor.** A distinção é a
   * regra inteira desta rota e está escrita em `presentConfigured` abaixo: um
   * administrador de plataforma tem toda a confiança do sistema e ainda assim
   * não precisa ler a chave da Asaas numa tela de navegador — ela não muda
   * nada que ele possa fazer, e passa a existir no histórico do navegador, no
   * cache do proxy e na captura de tela do chamado.
   *
   * Os ENDEREÇOS vão inteiros, e não é inconsistência: `panelBaseDomain` já sai
   * em `/api/tenant/public`, que é aberta, e um endereço é público por
   * construção — é para onde as pessoas apontam o navegador.
   */
  static async deployment(req, res) {
    const client = resolveClient();
    // Resolvido antes da resposta: a chave e o token do gateway passaram a
    // poder vir do console, e saber se existem é uma leitura na caixa da
    // plataforma. Falhar aqui é falhar a tela inteira, e com 500 — melhor que
    // responder "não configurado" para um deploy que está.
    let configured;
    try {
      configured = await PlatformController.presentConfigured(client);
    } catch (error) {
      console.error('Deployment facts error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to read the deployment facts', error.message)
      );
    }
    return res.json(createResponse('Deployment retrieved successfully', {
      edition: EDITION,
      database: {
        // O dialeto, e só. Host, usuário e nome do banco ficam de fora: a
        // pergunta que esta tela responde é "estou em SQLite ou em Postgres?",
        // e o resto é topologia de infraestrutura que a tela não usa.
        client,
        // De onde veio a conexão. Um deploy apontado para o banco errado é
        // quase sempre `DATABASE_URL` ganhando de um `db-config.json` esquecido
        // no volume — e sem esta linha as duas situações são idênticas na tela.
        source: process.env.DATABASE_URL ? 'env' : 'file'
      },
      addressing: {
        panelBaseDomain: panelBaseDomain(),
        portalBaseDomain: portalBaseDomain(),
        publicBaseUrl: String(process.env.PUBLIC_BASE_URL || '').trim() || null,
        tenantSubdomains: usesTenantSubdomains(),
        // O molde do endereço de GenieACS que o onboarding sugere a cada
        // provedor novo. Inteiro e não booleano, pelo mesmo motivo dos três
        // acima: é endereço, não segredo — e ler `{slug}` aqui é a única forma
        // de conferir que a variável foi lida como se pretendia. Um template
        // com a porta errada devolve sugestão nenhuma, em silêncio; esta linha
        // é onde isso deixa de ser invisível.
        genieAcsTemplate: String(process.env.GENIEACS_URL_TEMPLATE || '').trim() || null
      },
      configured
    }));
  }

  /**
   * O que está configurado, como booleano — nunca o valor.
   *
   * Cada linha aqui é uma variável de ambiente cuja ausência causa um sintoma
   * que não se parece com "falta configurar":
   *
   * - **mail**: sem SMTP o convite não é enviado, o link volta na resposta da
   *   API, e quem convidou acha que o e-mail sumiu no spam do colega.
   * - **metricsToken**: sem ele o coletor de métricas recebe 401 e o painel
   *   simplesmente não aparece no Prometheus.
   * - **billingWebhookToken**: sem ele a rota do webhook responde **404** de
   *   propósito — uma rota que move dinheiro não fica aberta porque alguém
   *   esqueceu uma variável. O sintoma é "o Asaas diz que entregou e o painel
   *   não creditou".
   * - **billingGateway**: sem a chave da API nada é emitido e todo provedor
   *   fica em cobrança manual, silenciosamente.
   * - **rls**: a segunda linha de isolamento, que só vale em Postgres. Ler
   *   `false` num deploy que ligou `RLS_ENABLED=true` e está em SQLite é a
   *   resposta certa, e é a que ninguém tem hoje.
   */
  static async presentConfigured(client = resolveClient()) {
    // As duas do gateway saem da mesma leitura que o webhook e a emissão fazem
    // — o console primeiro, o ambiente depois —, para que a tela nunca diga
    // "configurado" sobre um valor que a rota não vai usar.
    const gateway = await readAsaasSettings();
    return {
      mail: mailConfigured(),
      // 32 é o piso que `allowMetricsScraper` exige para sequer comparar: um
      // token mais curto está configurado e não funciona, que é pior do que
      // ausente. A tela precisa dizer a verdade sobre o que vai acontecer.
      metricsToken: String(process.env.METRICS_TOKEN || '').length >= 32,
      billingWebhookToken: gateway.webhookTokenConfigured,
      billingGateway: gateway.apiKeyConfigured,
      rls: rlsEnabled(client)
    };
  }

  /**
   * `GET /api/platform/catalogue` — de onde o próximo provedor herda o
   * catálogo de equipamentos, e quem hoje não tem nenhum.
   *
   * A tela existe porque a resposta não estava em lugar nenhum. O catálogo é o
   * que faz `VendorService.detectVendor` reconhecer o aparelho, e dele saem os
   * caminhos de parâmetro que o painel ESCREVE no CPE: sem ele, a troca de
   * senha de WiFi cai numa lista de caminhos adivinhados — inclusive quando
   * quem troca é o assinante pelo portal — e o provisionamento para de escrever
   * VLAN, service list e LAN binding. A falha é silenciosa: a tela só fica
   * errada, e ninguém liga isso a "o provedor nasceu sem catálogo".
   *
   * Só leitura, e de propósito: editar o catálogo padrão é editar o catálogo da
   * CAIXA da plataforma, nas telas que já existem e funcionam. Esta aba diz
   * qual catálogo está valendo e quem diverge — que é o fato que só o console
   * sabe, porque nenhum provedor enxerga os outros.
   */
  static async catalogue(req, res) {
    try {
      const db = getDb();
      const tamanhos = await catalogueSizes(db);
      const fonte = await catalogueSource(db, tamanhos);
      const caixa = await Tenant.platform();

      // Os NOMES dos fabricantes saem pelo model, dentro do provedor da fonte.
      // Alcançar a tabela pelo handle cru seria mais curto e é exatamente o que
      // a sentinela estática de escopo existe para pegar: tabela escopada lida
      // fora de escopo passa a depender de o autor ter lembrado do `where`.
      // (Escrever aqui o nome da tabela ao lado daquela chamada faria a própria
      // sentinela acusar este comentário — ela lê o arquivo, não a intenção.)
      const fabricantes = fonte.id === null
        ? []
        : await runInTenant(fonte.id, () => Vendor.getAll());

      const contar = (id) => Number(tamanhos.get(Number(id)) || 0);
      const provedores = await Tenant.providers();

      return res.json(createResponse('Catalogue retrieved successfully', {
        source: fonte.kind,
        sourceTenant: fonte.id === null ? null : PlatformController.presentCatalogueTenant(
          fonte.kind === 'platform' ? caixa : provedores.find((t) => Number(t.id) === fonte.id),
          fonte.id
        ),
        box: caixa ? PlatformController.presentCatalogueTenant(caixa, caixa.id) : null,
        defaults: {
          rows: contar(fonte.id),
          vendors: fabricantes.length,
          // Só o nome e se está ligado. O resto de uma linha de `vendors` são
          // caminhos de parâmetro TR-069, que não cabem numa lista e não são o
          // que esta tela responde.
          vendorNames: fabricantes.map((v) => ({ name: v.name, enabled: Boolean(v.enabled) }))
        },
        providers: provedores.map((t) => ({
          id: Number(t.id),
          name: t.name,
          slug: t.slug,
          rows: contar(t.id)
        }))
      }));
    } catch (error) {
      console.error('Platform catalogue error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to read the default catalogue', error.message)
      );
    }
  }

  /**
   * `POST /api/platform/catalogue/propagate` — `{ tenantIds?, overwrite? }`.
   *
   * Leva aos provedores o que a caixa da plataforma tem no catálogo e eles
   * não. Sem `overwrite`, o que o provedor já tem fica como ele deixou; com
   * ele, os perfis de mesmo nome recebem a versão padrão. Nada é apagado. Ver
   * `propagateCatalogue` em `config/seed.js`.
   *
   * Só da CAIXA: sem ela a "fonte" é o catálogo de um cliente, e empurrar o
   * ajuste de um ISP para os outros não é padrão nenhum.
   */
  static async propagateCatalogue(req, res) {
    try {
      const db = getDb();
      const fonte = await catalogueSource(db);
      if (fonte.kind !== 'platform') {
        return res.status(409).json(createErrorResponse(
          'The default catalogue is not the platform box yet; create it and fill its catalogue first'
        ));
      }
      const corpo = req.body ?? {};
      let tenantIds = null;
      if (corpo.tenantIds !== undefined && corpo.tenantIds !== null) {
        if (!Array.isArray(corpo.tenantIds) || corpo.tenantIds.some((id) => !Number.isInteger(Number(id)))) {
          return res.status(400).json(createErrorResponse('tenantIds must be a list of provider ids'));
        }
        const pedidos = corpo.tenantIds.map(Number);
        const provedores = new Set((await Tenant.providers()).map((t) => Number(t.id)));
        tenantIds = pedidos.filter((id) => provedores.has(id));
      }
      const overwrite = corpo.overwrite === true;
      const results = await propagateCatalogue(db, { sourceId: fonte.id, tenantIds, overwrite });

      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.CATALOGUE_PROPAGATED,
        detail: {
          overwrite,
          providers: results.length,
          added: results.reduce((n, r) => n + r.added, 0),
          updated: results.reduce((n, r) => n + r.updated, 0)
        }
      });
      return res.json(createResponse('Catalogue propagated', { overwrite, results }));
    } catch (error) {
      console.error('Platform catalogue propagate error:', error);
      return res.status(500).json(createErrorResponse('Failed to propagate the catalogue', error.message));
    }
  }

  /** Nome, slug e id — o bastante para a tela nomear um provedor e ligar nele. */
  static presentCatalogueTenant(tenant, fallbackId) {
    if (!tenant) return { id: Number(fallbackId), name: null, slug: null };
    return { id: Number(tenant.id), name: tenant.name, slug: tenant.slug };
  }

  /** `GET /api/platform/metrics` — the process's counters, per provider. */
  static metrics(req, res) {
    // `end`, not `send`: `send` rewrites the content type with its own charset
    // ordering, and a scraper matches the exposition type byte for byte.
    res.status(200);
    res.setHeader('Content-Type', METRICS_CONTENT_TYPE);
    res.setHeader('Cache-Control', 'no-store');
    return res.end(renderMetrics());
  }

  static async listTenants(req, res) {
    try {
      // `Tenant.list()` devolve os CLIENTES. A caixa da plataforma sai daqui e
      // viaja à parte, em `platformBox`, porque é outra coisa: misturá-la na
      // lista a faria aparecer com plano, estado de assinatura e botão de
      // suspender, que é exatamente a confusão que o `kind` existe para
      // desfazer — e o primeiro efeito seria alguém suspender a própria caixa
      // achando que estava mexendo num cliente.
      const tenants = await Tenant.list();
      const counts = await Tenant.operatorCounts();
      const subscriptions = await subscriptionsByTenant();
      const caixa = await Tenant.platform();
      return res.json(createResponse('Tenants retrieved successfully', {
        tenants: tenants.map((tenant) => present(
          tenant,
          counts.get(Number(tenant.id)) || 0,
          subscriptions.get(Number(tenant.id)) || null
        )),
        // Três campos e nada mais: o console precisa do nome para escrever na
        // tela e do slug para montar o endereço onde há domínio-base. Plano,
        // cadastro fiscal e gateway não vêm porque não há o que fazer com eles
        // — ela não é cobrada.
        platformBox: caixa
          ? { id: caixa.id, slug: caixa.slug, name: caixa.name, operators: counts.get(Number(caixa.id)) || 0 }
          : null
      }));
    } catch (error) {
      console.error('List tenants error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to list providers', error.message)
      );
    }
  }

  /**
   * Creates a provider, seeded exactly as one created at boot would be.
   *
   * The two writes are one transaction on purpose. `seedDefaults` is what gives
   * a provider its settings and its copy of the equipment catalogue, and a
   * provider that exists without them does not fail loudly — it comes up with
   * no GenieACS address and with equipment detection that matches nothing, so
   * the panel merely looks broken to whoever was just handed it. Either both
   * happen or neither does.
   */
  static async create(req, res) {
    try {
      // Read exactly what was sent. `trim()` here would be the silent
      // normalisation the rule above exists to refuse.
      const slug = String(req.body?.slug ?? '');
      const name = String(req.body?.name ?? '').trim();

      const problem = slugProblem(slug);
      if (problem) {
        return res.status(400).json(createErrorResponse(problem));
      }
      if (name.length < 1 || name.length > NAME_MAX_LENGTH) {
        return res.status(400).json(
          createErrorResponse(`Name must be between 1 and ${NAME_MAX_LENGTH} characters`)
        );
      }
      if (await Tenant.findBySlug(slug)) {
        return res.status(409).json(createErrorResponse('Slug already taken'));
      }

      let id;
      try {
        await getDb().transaction(async (trx) => {
          id = await Tenant.create({ slug, name }, trx);
          // The same call the boot path makes, so a provider minted at
          // runtime is born through the code that mints one at boot rather
          // than through a second implementation that would drift from it —
          // but scoped to the one provider being minted. The whole-deployment
          // pass was defended here as "a handful of reads"; measured, it is
          // seventeen queries per EXISTING provider even when there is nothing
          // to insert, and it ran inside this transaction. See `seedDefaults`.
          //
          // The transaction is passed rather than left to default to `getDb()`,
          // for the same reason `dbManagementService` passes the target of a
          // database switch: the new provider is not visible outside this
          // transaction yet, so seeding on another connection would not see it.
          await seedDefaults(trx, { tenantIds: [id] });
        });
      } catch (error) {
        // Two writers racing on the same slug both pass the check above and one
        // loses on the unique index. Reading the table back tells the two apart
        // without having to recognise a constraint-violation error on three
        // different engines, and the loser gets the same 409 they would have
        // got a moment earlier.
        if (await Tenant.findBySlug(slug)) {
          return res.status(409).json(createErrorResponse('Slug already taken'));
        }
        throw error;
      }

      const created = await Tenant.findById(id);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_CREATED,
        tenant: created
      });
      const subscriptions = await subscriptionsByTenant();
      return res.status(201).json(createResponse('Tenant created successfully', {
        tenant: present(created, 0, subscriptions.get(Number(id)) || null)
      }));
    } catch (error) {
      console.error('Create tenant error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to create the provider', error.message)
      );
    }
  }

  /**
   * `PATCH /api/platform/tenants/:id` — duas intenções, uma rota.
   *
   * `status` é a chave de ciclo de vida do provedor; `name` e `slug` são
   * correção de cadastro. Mandar as duas coisas no mesmo corpo é RECUSADO, e
   * não atendido: elas gravam linhas de trilha diferentes, só uma delas
   * invalida o cache do resolvedor, e só uma delas muda o endereço que o ISP
   * já recebeu. Atender as duas juntas tornaria ambíguo qual delas a linha da
   * trilha descreve — e é a mesma razão pela qual plano e estado da assinatura
   * são dois salvamentos separados na tela.
   *
   * A presença é testada por chave própria, e não por valor: `{ status: null }`
   * tem que continuar caindo no caminho do status e voltando 400, em vez de
   * virar uma edição de identidade que não traz campo nenhum.
   */
  static async update(req, res) {
    const corpo = req.body ?? {};
    const tem = (chave) => Object.prototype.hasOwnProperty.call(corpo, chave);
    const identidade = tem('name') || tem('slug');
    const gateway = tem('gateway');
    if ([identidade, gateway, tem('status')].filter(Boolean).length > 1) {
      return res.status(400).json(createErrorResponse(
        'Send the status, the name and slug, or the gateway — one at a time'
      ));
    }
    if (gateway) return PlatformController.setGateway(req, res);
    return identidade
      ? PlatformController.updateIdentity(req, res)
      : PlatformController.setStatus(req, res);
  }

  /**
   * Liga (ou desliga) um provedor do gateway de pagamento.
   *
   * No console e não na tela do provedor, ao contrário do cadastro fiscal: o
   * fiscal é dado que o cliente mantém e corrige sozinho quando muda de
   * endereço; isto é a correlação que decide **de quem é o dinheiro que entra
   * pelo webhook**. Um provedor que pudesse escrever o próprio
   * `billing_customer_ref` poderia apontá-lo para o cliente de gateway de
   * outro e receber o crédito do pagamento alheio.
   *
   * Sem validar o formato do id do cliente: ele é opaco e é do gateway, e
   * inventar aqui uma regra sobre a forma dele é a segunda cópia de uma regra
   * que não é nossa. O que se valida é o tamanho, porque a coluna tem um.
   */
  static async setGateway(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      const enviado = req.body?.gateway ?? {};
      const nome = enviado.gateway === undefined ? undefined : String(enviado.gateway ?? '').trim();
      const ref = enviado.customerRef === undefined
        ? undefined
        : String(enviado.customerRef ?? '').trim();

      if (nome !== undefined && nome.length > 32) {
        return res.status(400).json(createErrorResponse('Gateway name is too long'));
      }
      // E tem que ser um gateway que existe. Um `asas` digitado errado passaria
      // pelo tamanho, e o job de emissão responderia `not_linked` para sempre —
      // sem ruído nenhum, porque "não está ligado" é uma resposta legítima. O
      // cliente ficaria sem cobrança e ninguém saberia por quê.
      if (nome) {
        const conhecido = providerFor(nome);
        if (!conhecido) {
          return res.status(400).json(createErrorResponse(
            `Unknown billing gateway "${nome}"; known: ${[...PROVEDORES.keys()].join(', ')}`
          ));
        }
      }
      if (ref !== undefined && ref.length > 128) {
        return res.status(400).json(createErrorResponse('Gateway customer reference is too long'));
      }
      // Um id de cliente sem gateway não diz nada: é uma correlação pela metade,
      // e o webhook procura pelos dois juntos. Recusar aqui é mais barato do que
      // um pagamento que não resolve provedor nenhum e vira linha de log.
      const gatewayFinal = nome === undefined ? (tenant.billing_gateway ?? '') : nome;
      const refFinal = ref === undefined ? (tenant.billing_customer_ref ?? '') : ref;
      if (Boolean(gatewayFinal) !== Boolean(refFinal)) {
        return res.status(400).json(createErrorResponse(
          'Set the gateway and the customer reference together, or clear both'
        ));
      }

      const patch = {};
      if (nome !== undefined) patch.billing_gateway = nome;
      if (ref !== undefined) patch.billing_customer_ref = ref;
      await Tenant.updateGateway(id, patch);

      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_GATEWAY_CHANGED,
        tenant,
        // O nome do gateway, sim; o id do cliente, não. Ele é a chave que
        // decide para quem vai o crédito de um pagamento, e a trilha da
        // plataforma é lida por mais gente do que o console.
        detail: { gateway: gatewayFinal || null, linked: Boolean(refFinal) }
      });
      if (!registrada) {
        console.warn(`Provider ${id} gateway changed without a platform trail line`);
      }

      const atual = await Tenant.findById(id);
      return res.json(createResponse('Gateway updated', {
        id, gateway: Tenant.presentGateway(atual)
      }));
    } catch (error) {
      console.error('Set tenant gateway error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update the gateway', error.message)
      );
    }
  }

  /**
   * Corrige o nome e o subdomínio de um provedor já cadastrado.
   *
   * Antes disto, um nome digitado errado ou um subdomínio escolhido antes de o
   * ISP fechar a marca eram definitivos: a única saída era apagar e recriar, o
   * que leva os assinantes, os aparelhos e as conversas junto.
   *
   * O campo que não vem no corpo NÃO é mexido, e o que vem igual ao que já está
   * gravado não é escrito: um provedor pode ter só o nome corrigido, e um
   * salvamento que não mudou nada volta 200 sem linha de trilha e sem esvaziar
   * cache nenhum.
   *
   * Trocar o slug é a metade com consequência fora deste arquivo, e as três
   * estão nos comentários abaixo: o índice único decide corridas, o resolvedor
   * guarda o endereço antigo, e a trilha do PRÓPRIO provedor é onde o ISP vai
   * procurar a explicação.
   */
  static async updateIdentity(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }

      const corpo = req.body ?? {};
      const mandouNome = Object.prototype.hasOwnProperty.call(corpo, 'name');
      const mandouSlug = Object.prototype.hasOwnProperty.call(corpo, 'slug');

      // O slug é lido exatamente como veio — sem `trim()` e sem `toLowerCase()`
      // —, pela mesma razão da criação: quem edita está prestes a dar o endereço
      // do painel a um ISP, e um endereço reescrito em silêncio não é o que a
      // pessoa digitou. O nome, sim: espaço nas pontas de um nome não muda
      // endereço nenhum.
      const name = mandouNome ? String(corpo.name ?? '').trim() : null;
      const slug = mandouSlug ? String(corpo.slug ?? '') : null;

      if (mandouNome && (name.length < 1 || name.length > NAME_MAX_LENGTH)) {
        return res.status(400).json(
          createErrorResponse(`Name must be between 1 and ${NAME_MAX_LENGTH} characters`)
        );
      }
      if (mandouSlug) {
        const problem = slugProblem(slug);
        if (problem) {
          return res.status(400).json(createErrorResponse(problem));
        }
      }

      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      const nomeNovo = mandouNome ? name : tenant.name;
      const slugNovo = mandouSlug ? slug : tenant.slug;
      const mudouNome = nomeNovo !== tenant.name;
      const mudouSlug = slugNovo !== tenant.slug;

      const responder = async (row) => {
        const counts = await Tenant.operatorCounts();
        const subscriptions = await subscriptionsByTenant();
        return res.json(createResponse('Tenant updated successfully', {
          tenant: present(row, counts.get(Number(id)) || 0, subscriptions.get(Number(id)) || null)
        }));
      };

      // Nada mudou: 200 e mais nada. Uma linha de trilha dizendo "de X para X"
      // é ruído numa tabela que existe para ser lida, e esvaziar o cache do
      // resolvedor por um pedido que não mexeu em endereço nenhum é um custo
      // sem troco.
      if (!mudouNome && !mudouSlug) {
        return responder(tenant);
      }

      // O 409 é só quando a linha achada é de OUTRO provedor. `findBySlug`
      // compara pelo slug em minúsculas e acha esta mesma linha, então sem a
      // exclusão pelo id um salvamento que só troca o nome — e devolve o slug
      // atual junto, como a tela faz — responderia conflito consigo mesmo.
      if (mudouSlug) {
        const rival = await Tenant.findBySlug(slugNovo);
        if (rival && Number(rival.id) !== id) {
          return res.status(409).json(createErrorResponse('Slug already taken'));
        }
      }

      try {
        await Tenant.updateIdentity(id, {
          name: mudouNome ? nomeNovo : undefined,
          slug: mudouSlug ? slugNovo : undefined
        });
      } catch (error) {
        // A mesma corrida da criação, vista do outro lado: dois pedidos
        // re-endereçando dois provedores para o mesmo slug passam os dois pela
        // conferência acima e um perde no índice único. Reler a tabela separa
        // isso de um erro de verdade sem ter que reconhecer a violação de
        // restrição em três bancos diferentes.
        const rival = await Tenant.findBySlug(slugNovo);
        if (rival && Number(rival.id) !== id) {
          return res.status(409).json(createErrorResponse('Slug already taken'));
        }
        throw error;
      }

      // Só quando o endereço mudou — e aí obrigatoriamente. O resolvedor guarda
      // slug -> id por `RESOLVED_TENANT_TTL_MS`, então sem isto o endereço
      // ANTIGO seguiria resolvendo para este provedor até a entrada vencer, o
      // que é pior que a suspensão sem invalidação: o endereço mudou de
      // propósito, e o velho ficaria servindo o painel de quem já não mora lá
      // enquanto está livre para ser dado a outro. Trocar o nome não mexe em
      // nada guardado, e por isso não passa por aqui.
      //
      // O cache é por processo: num deploy com mais de uma instância, esta
      // chamada só esvazia a desta, e as outras acompanham quando a entrada
      // delas vence — no máximo `RESOLVED_TENANT_TTL_MS` depois.
      if (mudouSlug) forgetResolvedTenant();

      const detail = {};
      if (mudouNome) detail.name = { from: tenant.name, to: nomeNovo };
      if (mudouSlug) detail.slug = { from: tenant.slug, to: slugNovo };

      // O retrato vai com a linha ANTIGA, como na mudança de estado: a pergunta
      // que esta linha responde é "o que foi feito com o provedor que eu
      // conhecia como X", e para onde ele foi está no detalhe.
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_IDENTITY_CHANGED,
        tenant,
        detail
      });

      // E na trilha DELE, pelo mesmo motivo da suspensão: quem vai perguntar
      // "quem mudou o nosso nome" ou "por que o nosso endereço mudou" é o ISP,
      // e ele não lê a nossa trilha. Duas ações e não uma porque são dois fatos
      // diferentes, e a frase de um não descreve o outro.
      if (mudouNome) {
        await runInTenant(id, () => AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.TENANT_RENAMED,
          actorKind: 'platform',
          subjectType: 'tenant',
          subjectId: id,
          detail: detail.name
        }));
      }
      if (mudouSlug) {
        await runInTenant(id, () => AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.TENANT_SLUG_CHANGED,
          actorKind: 'platform',
          subjectType: 'tenant',
          subjectId: id,
          detail: detail.slug
        }));
      }

      return responder(await Tenant.findById(id));
    } catch (error) {
      console.error('Update tenant identity error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update the provider', error.message)
      );
    }
  }

  /**
   * Suspends or reactivates a provider.
   *
   * `tenants.status` already means something everywhere in the panel:
   * `forEachTenant` visits only `active`, the media sweep walks past a
   * suspended provider, and the SGP webhook refuses a delivery for one. This
   * route does not invent that behaviour, it hands somebody the switch.
   *
   * Suspending IS a lockout, and this paragraph used to say the opposite —
   * "nothing in the sign-in path reads this column". `resolveTenant` reads it
   * (`middleware/tenantResolver.js`) and answers 404 for the whole host: the
   * panel, the subscriber portal, signed in or not. The old sentence described
   * a design that stopped being true, and it is a sentence about access
   * control, so whoever read it while touching suspension decided wrong.
   *
   * Turning a provider back on is done from HERE, on the control plane's own
   * host, which is why it still works. And the paragraph below depends on the
   * lockout being real: the two-step deletion trusts suspension to mean nobody
   * is working in there.
   */
  static async setStatus(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const status = req.body?.status;
      if (!TENANT_STATUSES.includes(status)) {
        return res.status(400).json(
          createErrorResponse(`Status must be one of: ${TENANT_STATUSES.join(', ')}`)
        );
      }

      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      await Tenant.setStatus(id, status);
      // O resolvedor guarda slug -> id por `RESOLVED_TENANT_TTL_MS` e não relê
      // o status nesse meio-tempo, então sem isto uma suspensão só passa a
      // valer quando a entrada vence (e, nas outras instâncias, é esse o prazo
      // de qualquer jeito): o painel e o portal do provedor suspenso seguem
      // servindo e ainda autenticando gente nova, enquanto os jobs de fundo —
      // que leem a coluna — param. Pior, a exclusão em duas etapas confia na suspensão
      // para significar "ninguém está trabalhando lá dentro".
      forgetResolvedTenant();
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_STATUS_CHANGED,
        tenant,
        detail: { from: tenant.status, to: status }
      });
      // A linha nasce NO provedor suspenso, não numa trilha da plataforma: quem
      // vai perguntar "por que meu painel parou" é o ISP, e a resposta tem que
      // estar onde ele consegue olhar. `actorKind: 'platform'` é o que diz que
      // a mão veio de fora — sem isso a trilha mostraria a ação sem nenhum
      // operador daquele provedor por trás, e não haveria como distinguir de
      // uma linha com o ator perdido.
      await runInTenant(id, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TENANT_STATUS_CHANGED,
        actorKind: 'platform',
        subjectType: 'tenant',
        subjectId: id,
        detail: { from: tenant.status, to: status }
      }));
      const updated = await Tenant.findById(id);
      const counts = await Tenant.operatorCounts();
      const subscriptions = await subscriptionsByTenant();
      return res.json(createResponse('Tenant updated successfully', {
        tenant: present(updated, counts.get(Number(id)) || 0, subscriptions.get(Number(id)) || null)
      }));
    } catch (error) {
      console.error('Update tenant error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update the provider', error.message)
      );
    }
  }

  /**
   * Apaga um provedor e tudo o que é dele.
   *
   * As quatro condições estão no comentário do topo do arquivo. O que vale
   * dizer aqui é a ORDEM, que é a única parte com risco técnico: as tabelas
   * escopadas apontam para `tenants` sem cascata, então apagar de cima para
   * baixo falha na primeira chave estrangeira. Apaga-se na ordem INVERSA à de
   * criação do schema — a mesma lista que o export usa, lida de trás para
   * frente — e só então a linha do provedor.
   *
   * Tudo numa transação: um provedor meio apagado é pior que um inteiro, porque
   * o que sobra não aparece em tela nenhuma (a resolução por host já não o
   * encontra) e continua ocupando os índices únicos por provedor.
   */
  /**
   * `GET /api/platform/tenants/:id/export` — o cadastro de um provedor, daqui
   * de cima.
   *
   * POR QUE ESTA ROTA PRECISA EXISTIR
   * ---------------------------------
   * O provedor já tem a dele (`GET /api/tenant/export`), e enquanto ele está
   * ativo é por lá que ele baixa o que é dele. O buraco é o suspenso: o
   * resolvedor devolve 404 no HOST inteiro de quem não está ativo
   * (`tenantResolver.js`), e a exclusão EXIGE suspensão antes. Então a ordem
   * obrigatória era: suspende — e o provedor perde o acesso ao painel e à
   * própria exportação — e só aí pode apagar. **A janela para o ISP levar os
   * dados dele fechava antes de a exclusão ser permitida**, e o que sai junto é
   * o cadastro dos assinantes dele.
   *
   * Vale nos dois estados, e não só no suspenso. Um recorte "só suspenso" faria
   * o console exigir suspender para exportar — isto é, derrubar o painel de um
   * cliente para poder ajudá-lo —, que é o oposto do que esta rota existe para
   * consertar.
   *
   * GET COM ESCRITA, E POR QUÊ ESTÁ CERTO AQUI
   * ------------------------------------------
   * Ela escreve duas linhas de trilha. O achado central da varredura desta
   * sessão foi um `GET` que escrevia — mas o que estava errado lá era o que ele
   * escrevia: aposentava conta e apagava vínculo de ERP. Registrar a própria
   * leitura é a exceção que a exportação do provedor já faz, no mesmo formato,
   * e ela é o que separa "um arquivo saiu daqui" de "ninguém sabe".
   *
   * AS DUAS TRILHAS
   * ---------------
   * A da plataforma é CONDIÇÃO, no molde da exclusão: se não gravou, não envia.
   * Uma cópia dos assinantes de um cliente saindo sem registro é exatamente o
   * que não pode acontecer em silêncio, e o arquivo já está pronto na memória —
   * recusar aqui não desfaz nada, só não entrega.
   *
   * A do PROVEDOR é o outro lado, e é best-effort: quem pergunta "alguém baixou
   * a nossa base?" é o ISP, e ele não lê a nossa trilha. `actorKind: 'platform'`
   * diz de onde veio, como já fazem a renomeação e a troca de subdomínio.
   */
  static async exportTenant(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      // O serviço lê `currentTenantId()`, então o provedor entra em escopo aqui
      // — o mesmo `runInTenant` que as outras ações do console usam para tocar
      // a linha de um cliente. É por isso que a exportação daqui e a do próprio
      // provedor produzem o MESMO arquivo: é o mesmo código, sem um segundo
      // caminho para divergir.
      const arquivo = await runInTenant(id, () => TenantExportService.build());

      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_EXPORTED,
        tenant,
        detail: { status: tenant.status, rowCounts: arquivo.manifest.rowCounts }
      });
      if (!registrada) {
        return res.status(500).json(createErrorResponse(
          'The export was not recorded, so it was not delivered'
        ));
      }

      await runInTenant(id, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TENANT_EXPORTED,
        actorKind: 'platform',
        subjectType: 'tenant',
        subjectId: id,
        detail: { rowCounts: arquivo.manifest.rowCounts }
      }));

      const nome = ['skygenpanel', tenant.slug || 'export', new Date().toISOString().slice(0, 10)].join('-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nome}.json"`);
      return res.send(JSON.stringify(arquivo, null, 2));
    } catch (error) {
      console.error('Platform tenant export error:', error);
      return res.status(500).json(createErrorResponse('Could not export the provider', error.message));
    }
  }

  static async remove(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      // Suspender primeiro é o que transforma isto em dois passos com um
      // estado reversível no meio. Um provedor ativo tem gente trabalhando
      // nele agora.
      if (tenant.status !== 'suspended') {
        return res.status(409).json(createErrorResponse(
          'Suspend the provider before deleting it'
        ));
      }
      // O slug digitado de volta, exato — sem normalizar caixa nem espaço. É a
      // confirmação inteira: normalizar aqui aceitaria um slug "quase certo",
      // que é justamente o que um engano parece.
      if (req.body?.confirmSlug !== tenant.slug) {
        return res.status(409).json(createErrorResponse(
          'Type the provider slug exactly to confirm the deletion'
        ));
      }
      // O último provedor não sai — onde ele é o que sustenta o deployment.
      //
      // A regra existe por uma razão só, e ela é de resolução: sem nenhum
      // provedor, `resolveDefaultTenantId` devolve null e o deployment inteiro
      // passa a responder 503, inclusive para quem acabou de apagar, que perde
      // a rota para desfazer. Isso vale onde o host NÃO nomeia provedor.
      //
      // Onde há domínio-base nada disso se aplica: o provedor vem do host,
      // `resolveDefaultTenantId` nunca é chamado, e o console vive no endereço
      // da plataforma — que continua de pé. Um SaaS com zero provedores é um
      // estado coerente: é um SaaS que ainda não tem clientes, ou que acabou de
      // perder o último. Proibir apagar ali seria obrigar todo deploy a manter
      // para sempre o provedor `default` que a migração criou sozinha.
      if (!usesTenantSubdomains() && (await Tenant.list()).length <= 1) {
        return res.status(409).json(createErrorResponse(
          'The deployment must keep at least one provider'
        ));
      }

      const db = getDb();
      const escopadas = SCHEMA_TABLES.filter((tabela) => SCOPED_TABLES.has(tabela));
      const contagem = {};
      for (const tabela of escopadas) {
        const [linha] = await db(tabela).where({ tenant_id: id }).count({ n: '*' });
        contagem[tabela] = Number(linha?.n ?? 0);
      }
      const vinculos = await db('tenant_users').where({ tenant_id: id }).count({ n: '*' });
      contagem.tenant_users = Number(vinculos[0]?.n ?? 0);

      // ANTES de apagar, e conferido: aqui a trilha não é registro do que
      // houve, é condição para que aconteça.
      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_DELETED,
        tenant,
        detail: { rowCounts: contagem }
      });
      if (!registrada) {
        return res.status(500).json(createErrorResponse(
          'The deletion was not recorded, so it was not performed'
        ));
      }

      await db.transaction(async (trx) => {
        // De trás para frente: as filhas antes das mães, que é o inverso da
        // ordem em que o schema as cria.
        for (const tabela of [...escopadas].reverse()) {
          await trx(tabela).where({ tenant_id: id }).del();
        }
        // `tenant_invites` já saiu no laço acima — ela é escopada, então está
        // em `escopadas`. `tenant_users` NÃO está: ela é do deploy, porque uma
        // linha ali é uma PESSOA que pode trabalhar para outro provedor. O que
        // se apaga aqui é o vínculo dela com este, e nunca a pessoa.
        await trx('tenant_users').where({ tenant_id: id }).del();
        await trx('tenants').where({ id }).del();
      });

      // O laço acima apaga LINHAS, e os anexos do WhatsApp não são linhas: os
      // bytes moram em `DATA_DIR/wa-media/t<id>/`. Sem isto eles ficavam para
      // sempre — o único varredor que os alcançaria filtra por provedor
      // `active`, e a partir daqui não há mais linha em `tenants` para casar.
      // São fotos e documentos que assinantes mandaram.
      //
      // DEPOIS da transação, nunca dentro: um `rm` não desfaz com `rollback`.
      // E falha de disco não vira 500, porque o provedor JÁ foi excluído e a
      // trilha já registrou — dizer "falhou" aqui seria mentir sobre o que
      // aconteceu. O que sobra é um aviso e um caminho para alguém limpar.
      const midia = tenantMediaRoot(id);
      try {
        await fs.rm(midia, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `[platform] provedor ${id} excluído, mas ${midia} não pôde ser removido: ${error.message}`
        );
      }

      // O resolvedor guarda o id por slug e o primeiro provedor da tabela. Sem
      // isto, o processo continuaria resolvendo um provedor que não existe mais
      // até a entrada vencer — e o host dele responderia com o escopo de um fantasma.
      forgetResolvedTenant();

      return res.json(createResponse('Provider deleted successfully', {
        id, slug: tenant.slug, rowCounts: contagem
      }));
    } catch (error) {
      console.error('Delete tenant error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to delete the provider', error.message)
      );
    }
  }

  /** A trilha do plano de controle, da mais recente para a mais antiga. */
  static async listAudit(req, res) {
    try {
      const linhas = await PlatformAudit.list({
        limit: req.query?.limit,
        before: req.query?.before || null
      });
      return res.json(createResponse('Platform audit retrieved', {
        entries: linhas.map((linha) => ({
          id: linha.id,
          action: linha.action,
          actor: { userId: linha.actor_user_id, username: linha.actor_username },
          // Nome e slug vêm da linha e não de um join com `tenants`: o provedor
          // da linha mais importante desta tabela não existe mais.
          tenant: {
            id: linha.tenant_id,
            slug: linha.tenant_slug,
            name: linha.tenant_name
          },
          detail: linha.detail ? JSON.parse(linha.detail) : null,
          ip: linha.ip,
          at: linha.created_at
        })),
        nextBefore: linhas.length ? linhas[linhas.length - 1].id : null,
        actions: Object.values(PlatformAudit.ACTIONS)
      }));
    } catch (error) {
      console.error('List platform audit error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to read the platform audit', error.message)
      );
    }
  }
}

export default PlatformController;

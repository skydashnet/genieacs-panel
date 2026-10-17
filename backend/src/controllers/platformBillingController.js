import Plan, { PLAN_LIMIT_COLUMNS, parsePlanFeatures } from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import BillingEvent from '../models/BillingEvent.js';
import SubscriptionReminderSend from '../models/SubscriptionReminderSend.js';
import Tenant from '../models/Tenant.js';
import PlatformAudit from '../models/PlatformAudit.js';
import AuditLog from '../models/AuditLog.js';
import SubscriptionService, { STATUSES, BillingExemptError } from '../services/subscriptionService.js';
import { manualBilling } from '../services/billing/manualBillingProvider.js';
import { ChargeFollowError } from '../services/chargeIssuingService.js';
import DeviceService from '../services/deviceService.js';
import { runInTenant } from '../config/tenantContext.js';
import { tdb } from '../config/database.js';
import BillingInvoice from '../models/BillingInvoice.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import CouponService, { couponTrail } from '../services/couponService.js';
import { SelfBillingError } from '../services/selfBillingService.js';
import { translateError } from '../i18n/index.js';

/**
 * A metade comercial do plano de controle: planos, a assinatura de cada
 * provedor, o pagamento que nós registramos e o uso contra o limite.
 *
 * Tudo que muda a assinatura de um provedor é feito NO ESCOPO DELE
 * (`runInTenant`), pelo mesmo motivo de `PlatformController.setStatus`: o
 * extrato e a linha da trilha têm que nascer no provedor a quem pertencem, ou
 * ele não os vê no próprio painel. E cada mudança grava duas vezes — na trilha
 * da plataforma (o que NÓS fizemos) e na do provedor (o que aconteceu COM ele,
 * com `actorKind: 'platform'`).
 */

const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Um limite: inteiro ≥ 0, ou null para "sem limite". Qualquer outra coisa é erro. */
function parseLimit(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/**
 * O período pago: inteiro ≥ 1. Parser próprio e não `parseLimit`, porque
 * `parseLimit` aceita zero — e zero aqui é uma assinatura que vence no instante
 * em que é paga, que não é um plano, é um bug esperando um cliente. Ausente ou
 * vazio é "não mexer"; quem cria sem dizer nada recebe o default da coluna.
 */
function parsePeriodDays(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return { ok: false };
  return { ok: true, value: n };
}

/**
 * Os tetos de retenção: inteiro ≥ 1, ou vazio/nulo para "sem teto". Zero não
 * é aceito porque "zero dias" não é teto nenhum que faça sentido — apagaria
 * tudo, todo dia.
 */
const RETENTION_FIELDS = [
  ['maxAuditRetentionDays', 'max_audit_retention_days'],
  ['maxMessageRetentionDays', 'max_message_retention_days'],
  ['maxMediaRetentionDays', 'max_media_retention_days']
];

function parseRetentionCap(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return { ok: false };
  return { ok: true, value: n };
}

/** Lê os tetos do corpo em `target`; devolve a mensagem de erro, ou `null`. */
function readRetentionCaps(body, target) {
  for (const [key, column] of RETENTION_FIELDS) {
    if (body[key] === undefined) continue;
    const parsed = parseRetentionCap(body[key]);
    if (!parsed.ok) return `${key} must be an integer between 1 and 3650, or null`;
    target[column] = parsed.value;
  }
  return null;
}

const FEATURES_MAX = 20;
const FEATURE_MAX_LENGTH = 160;
const DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Os campos de vitrine (ver `PLAN_MARKETING_COLUMNS`) do corpo em `target`;
 * devolve a mensagem de erro, ou `null`. Ausente é "não mexer".
 */
function readMarketing(body, target) {
  for (const [key, column] of [['public', 'public'], ['featured', 'featured']]) {
    if (body[key] !== undefined) target[column] = Boolean(body[key]);
  }
  if (body.sortOrder !== undefined) {
    const n = Number(body.sortOrder);
    if (!Number.isInteger(n) || n < -1000 || n > 1000) return 'sortOrder must be an integer between -1000 and 1000';
    target.sort_order = n;
  }
  if (body.description !== undefined) {
    const text = body.description === null ? '' : String(body.description).trim();
    if (text.length > DESCRIPTION_MAX_LENGTH) return `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`;
    target.description = text || null;
  }
  if (body.features !== undefined) {
    const list = body.features === null ? [] : body.features;
    if (!Array.isArray(list) || list.length > FEATURES_MAX) {
      return `features must be a list of at most ${FEATURES_MAX} items`;
    }
    const clean = list.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (clean.some((item) => item.length > FEATURE_MAX_LENGTH)) {
      return `each feature must be at most ${FEATURE_MAX_LENGTH} characters`;
    }
    target.features = clean.length ? JSON.stringify(clean) : null;
  }
  if (body.priceYearlyCents !== undefined) {
    const parsed = parseLimit(body.priceYearlyCents);
    if (!parsed.ok) return 'priceYearlyCents must be a non-negative integer or null';
    target.price_yearly_cents = parsed.value;
  }
  return null;
}

/**
 * Os preços de excedente (0105) do corpo em `target` — `overagePriceCents:
 * { operators, subscribers, devices }`, cada um em centavos (inteiro ≥ 1) ou
 * nulo/vazio para "sem preço" (o teto barra). Ausente é "não mexer"; devolve
 * a mensagem de erro, ou `null`.
 */
const OVERAGE_FIELDS = [
  ['operators', 'overage_price_cents_operators'],
  ['subscribers', 'overage_price_cents_subscribers'],
  ['devices', 'overage_price_cents_devices']
];

function readOverage(body, target) {
  const precos = body.overagePriceCents;
  if (precos === undefined) return null;
  if (precos === null) {
    for (const [, column] of OVERAGE_FIELDS) target[column] = null;
    return null;
  }
  if (typeof precos !== 'object' || Array.isArray(precos)) {
    return 'overagePriceCents must be an object with operators, subscribers and devices';
  }
  for (const [key, column] of OVERAGE_FIELDS) {
    const valor = precos[key];
    if (valor === undefined) continue;
    if (valor === null || valor === '') {
      target[column] = null;
      continue;
    }
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 1 || n > 100_000_000) {
      return `overagePriceCents.${key} must be a positive integer of cents, or null`;
    }
    target[column] = n;
  }
  return null;
}

function presentPlan(plan) {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    limits: SubscriptionService.limitsOf(plan),
    // O preço por unidade acima do teto (0105); nulo é "o teto barra".
    overagePriceCents: SubscriptionService.overagePricesOf(plan),
    priceCents: Number(plan.price_cents ?? 0),
    currency: plan.currency,
    trialDays: Number(plan.trial_days ?? 0),
    // Quanto tempo um pagamento compra. Sem isto a tela nunca vê o campo, e um
    // plano anual seria criável só por SQL.
    periodDays: Number(plan.period_days ?? 30),
    // Até quantos dias o provedor pode guardar trilha, mensagens e anexos.
    retention: SubscriptionService.retentionCapsOf(plan),
    active: Boolean(plan.active),
    // A vitrine: se a página pública mostra, em que ordem e com que frases.
    public: Boolean(plan.public),
    featured: Boolean(plan.featured),
    sortOrder: Number(plan.sort_order ?? 0),
    description: plan.description ?? null,
    features: parsePlanFeatures(plan.features),
    priceYearlyCents: plan.price_yearly_cents === null || plan.price_yearly_cents === undefined
      ? null
      : Number(plan.price_yearly_cents),
    createdAt: plan.created_at ?? null
  };
}

async function tenantOr404(req, res) {
  const id = parseId(req.params?.id);
  if (!id) {
    res.status(400).json(createErrorResponse('Invalid provider id'));
    return null;
  }
  const tenant = await Tenant.findById(id);
  if (!tenant) {
    res.status(404).json(createErrorResponse('Provider not found'));
    return null;
  }
  return tenant;
}

/**
 * As duas trilhas, de uma vez.
 *
 * `tenantDetail` é o que vai à trilha do PROVEDOR quando ela não pode levar
 * tudo o que a da plataforma leva — o motivo da isenção de cobrança, que é
 * anotação interna do console. Sem ele, as duas levam o mesmo `detail`.
 */
async function recordBoth(req, tenant, { platformAction, detail, tenantDetail = detail }) {
  await PlatformAudit.fromRequest(req, { action: platformAction, tenant, detail });
  await runInTenant(tenant.id, () => AuditLog.fromRequest(req, {
    action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
    actorKind: 'platform',
    subjectType: 'subscription',
    subjectId: tenant.id,
    detail: { ...tenantDetail, platformAction }
  }));
}

/**
 * A assinatura de um provedor como o console a lê: o estado, o plano e o
 * extrato recente.
 *
 * Função e não só o corpo de `getSubscription` porque a tela de Assinaturas
 * responde a mudança de prazo com EXATAMENTE isto (ver
 * `PlatformSubscriptionsController.setDeadlines`) — e duas cópias do mesmo
 * objeto são duas telas que um dia discordam sobre o que é uma assinatura.
 */
async function subscriptionView(tenant) {
  const state = await runInTenant(tenant.id, () => SubscriptionService.current());
  const { events, notaDoEvento } = await runInTenant(tenant.id, async () => {
    const lidos = await BillingEvent.listRecent({ limit: 50 });
    return { events: lidos, notaDoEvento: await notasDoExtrato(lidos) };
  });
  // Os lembretes de cobrança que já saíram (0092), só para ler: o console
  // responde "ele foi avisado?" sem abrir o log do SMTP.
  const reminders = await runInTenant(tenant.id, () => SubscriptionReminderSend.listSent({ limit: 30 }));
  return {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    subscription: SubscriptionService.present(state, { withExemptReason: true }),
    planId: state.subscription?.plan_id ?? null,
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      amountCents: event.amount_cents,
      currency: event.currency,
      provider: event.provider,
      externalId: event.external_id,
      detail: event.detail ? JSON.parse(event.detail) : null,
      at: event.created_at,
      // A cobrança que este pagamento quitou e a NFS-e dela — nulos fora do
      // pagamento, ou quando ele não tem cobrança do painel por trás.
      chargeId: notaDoEvento.get(event.id)?.chargeId ?? null,
      invoice: BillingInvoice.presentForConsole(notaDoEvento.get(event.id)?.invoice ?? null)
    })),
    reminders
  };
}

/**
 * Para cada pagamento do extrato, a cobrança que ele quitou e a nota dela.
 *
 * O pagamento guarda a referência com que entrou (`external_id`): o id da
 * cobrança no gateway, ou `charge:<id>` na baixa sem gateway. É por ela que
 * se acha a cobrança — no escopo do provedor, que quem chama já abriu.
 */
async function notasDoExtrato(events) {
  const pagamentos = events.filter((event) => event.type === 'payment.recorded' && event.external_id);
  if (!pagamentos.length) return new Map();
  const doGateway = [];
  const locais = [];
  for (const event of pagamentos) {
    const local = /^charge:(\d+)$/.exec(event.external_id);
    if (local) locais.push(Number(local[1]));
    else doGateway.push(event.external_id);
  }
  const cobrancas = await tdb('billing_charges').where((q) => {
    q.whereIn('id', locais.length ? locais : [0]);
    if (doGateway.length) q.orWhereIn('gateway_charge_id', doGateway);
  }).select('id', 'gateway_charge_id');
  const porGateway = new Map(cobrancas.filter((c) => c.gateway_charge_id).map((c) => [c.gateway_charge_id, c.id]));
  const ids = new Set(cobrancas.map((c) => Number(c.id)));
  const notas = await BillingInvoice.forCharges([...ids]);
  const mapa = new Map();
  for (const event of pagamentos) {
    const local = /^charge:(\d+)$/.exec(event.external_id);
    const chargeId = local ? Number(local[1]) : porGateway.get(event.external_id);
    if (!chargeId || !ids.has(Number(chargeId))) continue;
    mapa.set(event.id, { chargeId: Number(chargeId), invoice: notas.get(Number(chargeId)) || null });
  }
  return mapa;
}

class PlatformBillingController {
  // ── Planos ───────────────────────────────────────────────────────────

  static async listPlans(req, res) {
    try {
      const plans = await Plan.list();
      const counts = await Promise.all(plans.map((plan) => Plan.subscriberCount(plan.id)));
      return res.json(createResponse('Plans retrieved', {
        plans: plans.map((plan, i) => ({ ...presentPlan(plan), subscribers: counts[i] }))
      }));
    } catch (error) {
      console.error('List plans error:', error);
      return res.status(500).json(createErrorResponse('Failed to list plans', error.message));
    }
  }

  static async createPlan(req, res) {
    try {
      const body = req.body ?? {};
      const code = String(body.code ?? '');
      const name = String(body.name ?? '').trim();
      if (!CODE_PATTERN.test(code)) {
        return res.status(400).json(createErrorResponse(
          'Plan code must be 2 to 32 lowercase letters, digits, hyphens or underscores'
        ));
      }
      if (name.length < 1 || name.length > 128) {
        return res.status(400).json(createErrorResponse('Name must be between 1 and 128 characters'));
      }
      const row = { code, name };
      for (const [key, column] of [
        ['maxOperators', 'max_operators'],
        ['maxSubscribers', 'max_subscribers'],
        ['maxDevices', 'max_devices']
      ]) {
        const parsed = parseLimit(body[key]);
        if (!parsed.ok) {
          return res.status(400).json(createErrorResponse(`${key} must be a non-negative integer or null`));
        }
        row[column] = parsed.value;
      }
      const price = parseLimit(body.priceCents);
      const trial = parseLimit(body.trialDays);
      if (!price.ok || !trial.ok) {
        return res.status(400).json(createErrorResponse('priceCents and trialDays must be non-negative integers'));
      }
      const periodo = parsePeriodDays(body.periodDays);
      if (!periodo.ok) {
        return res.status(400).json(createErrorResponse('periodDays must be an integer of at least 1'));
      }
      row.price_cents = price.value ?? 0;
      row.trial_days = trial.value ?? 0;
      // Ausente fica com o default da coluna, e não com um 30 repetido aqui: a
      // segunda cópia de um default é a que diverge quando a primeira muda.
      if (periodo.value !== null) row.period_days = periodo.value;
      const erroRetencao = readRetentionCaps(body, row);
      if (erroRetencao) return res.status(400).json(createErrorResponse(erroRetencao));
      const erroVitrine = readMarketing(body, row);
      if (erroVitrine) return res.status(400).json(createErrorResponse(erroVitrine));
      const erroExcedente = readOverage(body, row);
      if (erroExcedente) return res.status(400).json(createErrorResponse(erroExcedente));
      row.currency = String(body.currency ?? 'BRL').toUpperCase().slice(0, 3);
      row.active = body.active === undefined ? true : Boolean(body.active);

      if (await Plan.findByCode(code)) {
        return res.status(409).json(createErrorResponse('Plan code already taken'));
      }
      const plan = await Plan.create(row);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLAN_CREATED,
        detail: presentPlan(plan)
      });
      return res.status(201).json(createResponse('Plan created', { plan: presentPlan(plan) }));
    } catch (error) {
      console.error('Create plan error:', error);
      return res.status(500).json(createErrorResponse('Failed to create the plan', error.message));
    }
  }

  /**
   * Muda nome, limites, preço, teste ou `active`. O `code` NÃO muda: é o que
   * os testes, o extrato e o seed nomeiam; renomear seria reescrever o passado.
   */
  static async updatePlan(req, res) {
    try {
      const id = parseId(req.params?.id);
      if (!id) return res.status(400).json(createErrorResponse('Invalid plan id'));
      const plan = await Plan.findById(id);
      if (!plan) return res.status(404).json(createErrorResponse('Plan not found'));

      const body = req.body ?? {};
      const patch = {};
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (name.length < 1 || name.length > 128) {
          return res.status(400).json(createErrorResponse('Name must be between 1 and 128 characters'));
        }
        patch.name = name;
      }
      for (const [key, column] of [
        ['maxOperators', 'max_operators'],
        ['maxSubscribers', 'max_subscribers'],
        ['maxDevices', 'max_devices'],
        ['priceCents', 'price_cents'],
        ['trialDays', 'trial_days']
      ]) {
        if (body[key] === undefined) continue;
        const parsed = parseLimit(body[key]);
        if (!parsed.ok) {
          return res.status(400).json(createErrorResponse(`${key} must be a non-negative integer or null`));
        }
        patch[column] = (column === 'price_cents' || column === 'trial_days') ? (parsed.value ?? 0) : parsed.value;
      }
      if (body.periodDays !== undefined) {
        const periodo = parsePeriodDays(body.periodDays);
        // Vazio não apaga: a coluna é NOT NULL, e um campo em branco na tela
        // significa "não mudei isto" e nunca "esta assinatura não tem prazo".
        if (!periodo.ok) {
          return res.status(400).json(createErrorResponse('periodDays must be an integer of at least 1'));
        }
        if (periodo.value !== null) patch.period_days = periodo.value;
      }
      const erroRetencao = readRetentionCaps(body, patch);
      if (erroRetencao) return res.status(400).json(createErrorResponse(erroRetencao));
      const erroVitrine = readMarketing(body, patch);
      if (erroVitrine) return res.status(400).json(createErrorResponse(erroVitrine));
      const erroExcedente = readOverage(body, patch);
      if (erroExcedente) return res.status(400).json(createErrorResponse(erroExcedente));
      if (body.currency !== undefined) patch.currency = String(body.currency).toUpperCase().slice(0, 3);
      if (body.active !== undefined) patch.active = Boolean(body.active);
      if (Object.keys(patch).length === 0) {
        return res.status(400).json(createErrorResponse('Nothing to update'));
      }
      // O preço anual é COBRADO (0104): tirá-lo de um plano com assinaturas
      // no anual as faria voltar ao mensal em silêncio — preço e prazo de
      // outro ciclo do que foi contratado. Mudar o valor pode; apagar, não.
      if ('price_yearly_cents' in patch && !(Number(patch.price_yearly_cents) > 0)
        && Number(plan.price_yearly_cents) > 0) {
        const anuais = await Subscription.countAnnualOnPlan(id);
        if (anuais > 0) {
          return res.status(409).json(createErrorResponse(
            `${anuais} subscription(s) use the annual cycle of this plan; the annual price cannot be removed`,
            { count: anuais },
            'plan_has_annual_subscriptions'
          ));
        }
      }

      const updated = await Plan.update(id, patch);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLAN_UPDATED,
        detail: { id, before: presentPlan(plan), after: presentPlan(updated) }
      });
      return res.json(createResponse('Plan updated', { plan: presentPlan(updated) }));
    } catch (error) {
      console.error('Update plan error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the plan', error.message));
    }
  }

  // ── A assinatura de um provedor ─────────────────────────────────────

  static async getSubscription(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      return res.json(createResponse('Subscription retrieved', await subscriptionView(tenant)));
    } catch (error) {
      console.error('Get subscription error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the subscription', error.message));
    }
  }

  /**
   * `PUT /tenants/:id/subscription` com `planId` e/ou `status` (mais
   * `trialEndsAt`/`renewsAt` quando o status pede). Um pedido pode trazer os
   * dois; cada um vira a sua linha no extrato.
   */
  static async updateSubscription(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const body = req.body ?? {};
      const planId = body.planId === undefined ? undefined : parseId(body.planId);
      const status = body.status;
      if (body.planId !== undefined && !planId) {
        return res.status(400).json(createErrorResponse('Invalid plan id'));
      }
      if (planId && !(await Plan.findById(planId))) {
        return res.status(404).json(createErrorResponse('Plan not found'));
      }
      if (status !== undefined && !STATUSES.includes(status)) {
        return res.status(400).json(createErrorResponse(`Status must be one of: ${STATUSES.join(', ')}`));
      }
      if (planId === undefined && status === undefined) {
        return res.status(400).json(createErrorResponse('Nothing to update'));
      }
      for (const key of ['trialEndsAt', 'renewsAt']) {
        if (body[key] !== undefined && body[key] !== null && Number.isNaN(new Date(body[key]).getTime())) {
          return res.status(400).json(createErrorResponse(`${key} must be a date`));
        }
      }

      const before = await Subscription.forTenant(tenant.id);
      const actorUserId = req.user?.userId ?? null;
      try {
        await runInTenant(tenant.id, async () => {
          // O status (com as datas) ANTES do plano: é ele que pode ser recusado
          // — a cobrança em aberto acompanha o prazo novo no gateway, e o
          // gateway pode dizer não (ver `ChargeIssuingService.followDeadline`).
          // Na ordem inversa, a recusa chegaria com o plano já trocado, e o
          // pedido teria valido pela metade.
          if (status !== undefined) {
            await SubscriptionService.setStatus({
              status,
              reason: body.reason ? String(body.reason).slice(0, 255) : null,
              actorUserId,
              trialEndsAt: body.trialEndsAt,
              renewsAt: body.renewsAt
            });
          }
          if (planId !== undefined) {
            await SubscriptionService.changePlan({ planId, actorUserId });
          }
        });
      } catch (error) {
        if (error instanceof ChargeFollowError) {
          return res.status(error.status).json({
            ...createErrorResponse(error.message, null, error.code),
            ...(error.detail ? { detail: error.detail } : {})
          });
        }
        throw error;
      }
      const after = await Subscription.forTenant(tenant.id);

      if (planId !== undefined) {
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_PLAN_CHANGED,
          detail: { from: before?.plan_id ?? null, to: planId }
        });
      }
      if (status !== undefined) {
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_STATUS_CHANGED,
          detail: { from: before?.status ?? null, to: status, reason: body.reason ?? null }
        });
      }

      const state = await runInTenant(tenant.id, () => SubscriptionService.current());
      return res.json(createResponse('Subscription updated', {
        subscription: SubscriptionService.present(state, { withExemptReason: true }),
        planId: after?.plan_id ?? null
      }));
    } catch (error) {
      console.error('Update subscription error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the subscription', error.message));
    }
  }

  /**
   * `PUT /tenants/:id/subscription/billing-exempt` — `{ exempt, reason?, until? }`:
   * liga ou desliga o "isento de cobrança" (ver
   * `SubscriptionService.setBillingExempt`). `until` é a data de fim (ISO,
   * no futuro, senão 400 `invalid_until`), ou nulo/ausente para "até alguém
   * desligar"; só com `exempt: true` (400 `until_requires_exempt`). Já
   * isento, um `until` diferente muda só a data (`untilChanged: true`).
   *
   * Responde `{ subscription, canceledCharges, failedCharges, alreadyInState, untilChanged }`
   * (`failedCharges` é quantas ficaram em aberto), com
   * `subscription` no MESMO formato de `GET /tenants/:id/subscription`
   * (`subscriptionView`), para a tela trocar o que mostra sem perguntar de
   * novo. Pedir o estado em que já está não é erro nem gesto: 200 com
   * `alreadyInState: true`, e nenhuma linha em trilha nenhuma.
   *
   * A caixa da plataforma responde 404, como na tela de Assinaturas: ela não
   * é cliente e não tem cobrança de que isentar.
   */
  static async setBillingExempt(req, res) {
    try {
      const body = req.body ?? {};
      if (typeof body.exempt !== 'boolean') {
        return res.status(400).json(createErrorResponse('exempt must be true or false'));
      }
      if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
        return res.status(400).json(createErrorResponse('reason must be a string'));
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length > 255) {
        return res.status(400).json(createErrorResponse('reason must be at most 255 characters'));
      }
      if (body.until !== undefined && body.until !== null
        && (typeof body.until !== 'string' || !body.until.trim() || Number.isNaN(Date.parse(body.until)))) {
        return res.status(400).json(createErrorResponse('until must be an ISO date-time', null, 'invalid_until'));
      }

      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      if (tenant.kind === 'platform') return res.status(404).json(createErrorResponse('Provider not found'));

      let resultado;
      try {
        resultado = await SubscriptionService.setBillingExempt({
          tenantId: tenant.id,
          exempt: body.exempt,
          reason: reason || null,
          until: body.until,
          actorUserId: req.user?.userId ?? null
        });
      } catch (error) {
        if (error instanceof BillingExemptError) {
          return res.status(error.status).json(createErrorResponse(error.message, null, error.code));
        }
        throw error;
      }

      if (!resultado.alreadyInState) {
        const detail = {
          exempt: body.exempt,
          reason: reason || null,
          until: resultado.subscription?.billing_exempt_until
            ? new Date(resultado.subscription.billing_exempt_until).toISOString() : null,
          ...(resultado.untilChanged ? { untilChanged: true, untilBefore: resultado.untilBefore ?? null } : {}),
          statusBefore: resultado.statusBefore,
          statusAfter: resultado.statusAfter,
          canceledCharges: resultado.canceledCharges,
          // As que o gateway não cancelou e ficaram em aberto: é a trilha
          // que responde "por que este isento ainda tem fatura viva?".
          ...(resultado.failedCharges.length ? { chargesLeftOpen: resultado.failedCharges } : {}),
          ...(resultado.reopenedCharge ? { reopenedCharge: true } : {}),
          renewsAt: resultado.subscription?.renews_at ?? null
        };
        // O motivo fica só na trilha da plataforma: o provedor lê a dele, e o
        // motivo é anotação interna do console (ver `presentBillingExempt`).
        const { reason: _motivo, ...tenantDetail } = detail;
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_BILLING_EXEMPT_CHANGED,
          detail,
          tenantDetail
        });
      }

      return res.json(createResponse(
        resultado.untilChanged ? 'Billing exemption end date updated'
          : (body.exempt ? 'Billing exemption enabled' : 'Billing exemption disabled'),
        {
          subscription: await subscriptionView(tenant),
          canceledCharges: resultado.canceledCharges,
          // As que ficaram em aberto (o gateway recusou, ou estavam ocupadas):
          // a tela avisa, e a varredura do agendador tenta de novo.
          failedCharges: resultado.failedCharges.length,
          alreadyInState: resultado.alreadyInState,
          untilChanged: Boolean(resultado.untilChanged)
        }
      ));
    } catch (error) {
      console.error('Set billing exemption error:', error);
      return res.status(500).json(createErrorResponse('Failed to change the billing exemption', error.message));
    }
  }

  /**
   * `PUT /tenants/:id/subscription/coupon` — `{ code }` aplica (substituindo
   * o que houver), `{ code: null }` tira. As recusas do cupom são 409 com o
   * código que a tela lê (`coupon_invalid`, `coupon_expired`,
   * `coupon_exhausted`, `coupon_plan_mismatch`, `coupon_already_applied`); o
   * gateway que recusa cancelar a fatura em aberto é 502 e nada muda.
   */
  static async setCoupon(req, res) {
    try {
      const body = req.body ?? {};
      if (!('code' in body) || (body.code !== null && typeof body.code !== 'string')) {
        return res.status(400).json(createErrorResponse('code must be a string or null'));
      }
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      if (tenant.kind === 'platform') return res.status(404).json(createErrorResponse('Provider not found'));

      const tirar = body.code === null || body.code.trim() === '';
      let resultado;
      try {
        resultado = tirar
          ? await CouponService.remove({
            tenantId: tenant.id,
            actorUserId: req.user?.userId ?? null,
            countDevices: () => runInTenant(tenant.id, () => DeviceService.countDevicesFromGenieAcs())
          })
          : await CouponService.apply({
            tenantId: tenant.id,
            code: body.code,
            actorUserId: req.user?.userId ?? null,
            source: 'console',
            countDevices: () => runInTenant(tenant.id, () => DeviceService.countDevicesFromGenieAcs())
          });
      } catch (error) {
        if (error instanceof SelfBillingError) {
          return res.status(error.status || 409).json({
            ...createErrorResponse(translateError(req.t ?? ((k) => k), error), error.detail ?? null, error.code),
            ...(error.extra ?? {})
          });
        }
        throw error;
      }

      if (tirar ? resultado.changed : true) {
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_COUPON_CHANGED,
          detail: {
            coupon: tirar ? null : couponTrail(resultado.coupon),
            ...(tirar ? { removedCoupon: couponTrail(resultado.coupon) } : {}),
            ...(resultado.replacedCouponId ? { replacedCouponId: resultado.replacedCouponId } : {}),
            ...(resultado.priceCents !== undefined ? { priceCents: resultado.priceCents } : {}),
            ...(resultado.charge !== 'none' ? { openCharge: resultado.charge } : {})
          }
        });
      }

      return res.json(createResponse(tirar ? 'Coupon removed' : 'Coupon applied', {
        subscription: await subscriptionView(tenant),
        charge: resultado.charge,
        changed: tirar ? resultado.changed : true
      }));
    } catch (error) {
      console.error('Set subscription coupon error:', error);
      return res.status(500).json(createErrorResponse('Failed to change the coupon', error.message));
    }
  }

  /** Nós marcamos pago. */
  static async recordPayment(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const body = req.body ?? {};
      const amount = Number(body.amountCents);
      if (!Number.isInteger(amount) || amount < 0) {
        return res.status(400).json(createErrorResponse('amountCents must be a non-negative integer'));
      }
      const currency = String(body.currency ?? 'BRL').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        return res.status(400).json(createErrorResponse('currency must be a three-letter code'));
      }
      const externalId = body.reference ? String(body.reference).slice(0, 128) : null;
      const before = await Subscription.forTenant(tenant.id);
      if (!before) return res.status(404).json(createErrorResponse('Subscription not found'));

      // O botão do console leva a mesma conferência que o webhook, e a razão é
      // que o erro aqui é mais provável, não menos: quem digita "1999" achando
      // que digitou "19990" não tem nada que o corrija, enquanto o gateway pelo
      // menos manda o valor que ele mesmo cobrou.
      //
      // `allowUnderpayment` é a saída, e é explícita como o `periodDays`: quem
      // a passa está dizendo que sabe mais que o catálogo naquele caso — um
      // acordo, uma entrada, um valor negociado fora do plano. O que ela não
      // pode ser é o padrão, porque aí a conferência não existe.
      const allowUnderpayment = body.allowUnderpayment === true;
      const { subscription: after, duplicate, underpaid, expectedCents } = await runInTenant(
        tenant.id,
        () => manualBilling.recordPayment({
          amountCents: amount,
          currency,
          externalId,
          allowUnderpayment,
          actorUserId: req.user?.userId ?? null
        })
      );

      // 409 e não 400: o pedido está bem formado e o valor é um valor possível
      // — o que não bate é com quanto se pediu, que é um conflito de estado.
      // Os dois números vão no corpo porque a tela precisa dizer QUANTO falta,
      // e porque repetir a conta no frontend seria a segunda cópia da regra.
      if (underpaid) {
        // Os dois números no TOPO do corpo, e não dentro de `data`: o cliente
        // de API encaminha campo nomeado num erro, não o `data` inteiro — é o
        // mesmo desenho do 402 de limite de plano, que manda `limit` e
        // `current` assim. A tela precisa dizer quanto falta, e refazer a conta
        // no frontend seria a segunda cópia da regra.
        return res.status(409).json({
          ...createErrorResponse('The amount is short of what was charged'),
          code: 'underpaid',
          paidCents: amount,
          expectedCents,
          currency
        });
      }
      // Uma referência já vista não é um segundo pagamento: nada foi
      // creditado, e uma segunda linha na trilha diria que foi.
      if (duplicate) {
        const state = await runInTenant(tenant.id, () => SubscriptionService.current());
        return res.status(200).json(createResponse('Payment already recorded', {
          subscription: SubscriptionService.present(state, { withExemptReason: true }),
          duplicate: true
        }));
      }
      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.PAYMENT_RECORDED,
        detail: {
          amountCents: amount,
          currency,
          reference: externalId,
          statusBefore: before.status,
          statusAfter: after.status,
          renewsAt: after.renews_at ?? null,
          // Só aparece quando alguém passou por cima da conferência. A trilha
          // da plataforma é onde se responde "quem deu desconto a quem", e uma
          // linha idêntica à de um pagamento cheio não responderia.
          ...(allowUnderpayment && expectedCents !== null && amount < expectedCents
            ? { underpaymentAccepted: true, expectedCents }
            : {})
        }
      });
      const state = await runInTenant(tenant.id, () => SubscriptionService.current());
      return res.status(201).json(createResponse('Payment recorded', {
        subscription: SubscriptionService.present(state, { withExemptReason: true })
      }));
    } catch (error) {
      console.error('Record payment error:', error);
      return res.status(500).json(createErrorResponse('Failed to record the payment', error.message));
    }
  }

  /** Uso contra o limite, com a contagem de ONTs vinda do GenieACS do provedor. */
  static async getUsage(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const usage = await runInTenant(tenant.id, () => SubscriptionService.usage({
        countDevices: () => DeviceService.countDevicesFromGenieAcs()
      }));
      return res.json(createResponse('Usage retrieved', {
        tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
        ...usage
      }));
    } catch (error) {
      console.error('Get usage error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the usage', error.message));
    }
  }
}

export { PLAN_LIMIT_COLUMNS, recordBoth, subscriptionView };
export default PlatformBillingController;

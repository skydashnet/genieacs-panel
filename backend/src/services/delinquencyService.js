import Tenant from '../models/Tenant.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import BillingCharge, { CHARGE_KINDS, isoDateOf } from '../models/BillingCharge.js';
import PlatformAudit from '../models/PlatformAudit.js';
import SubscriptionService, {
  BillingExemptError, SUSPENDED_REASONS, isAutoSuspended, isPauseScheduled, overdueSince
} from './subscriptionService.js';
import SubscriptionNoticeService from './subscriptionNoticeService.js';
import ChargeIssuingService, { ChargeFollowError } from './chargeIssuingService.js';
import { autoSuspendConfig } from './platformProfileService.js';
import { getDb, isUniqueViolation, tdb } from '../config/database.js';
import { runInTenant, runUnscoped } from '../config/tenantContext.js';

/**
 * O painel de inadimplência do console: quem está devendo, quanto, desde
 * quando, e a mão para agir sobre muitos de uma vez.
 *
 * ## Quem entra
 *
 * O provedor em atraso pelo estado que VALE (`effectiveStatus` → `past_due`,
 * menos a pausa da retenção), o suspenso automaticamente por inadimplência
 * (0102) e qualquer um com cobrança em aberto já vencida — a renovação, a
 * pró-rata (0101) ou a de excedente (0105). Ficam de fora a caixa da
 * plataforma, os isentos de cobrança, os cancelados e os pausados: nenhum
 * deles deve nada que se cobre hoje.
 *
 * ## Quanto
 *
 * A soma das cobranças em aberto JÁ VENCIDAS (`overdue`, ou com o vencimento
 * antes de hoje em São Paulo), separada por tipo. A que ainda vai vencer não
 * é atraso, e entra só como "em aberto" ao lado.
 *
 * ## As leituras
 *
 * Seis consultas, sempre, e nenhuma por provedor — como a tela de
 * Assinaturas: os provedores, as assinaturas com o plano, o catálogo, as
 * cobranças em aberto de todos e os lembretes mandados. As escopadas são
 * lidas sem escopo, com a razão escrita: é a tela que existe para ver todos.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** As faixas de atraso do resumo e do filtro, em dias. */
export const DELINQUENCY_BUCKETS = Object.freeze(['1-7', '8-15', '16-30', '30+']);

/** As ações em massa. */
export const DELINQUENCY_ACTIONS = Object.freeze(['remind', 'suspend', 'exempt', 'extend']);

/** O teto de provedores por pedido de ação em massa. */
export const MAX_BULK_TENANTS = 200;

/** O teto da cortesia em massa, em dias. */
export const MAX_EXTEND_DAYS = 60;

/** A faixa de quem deve há `dias` dias. Menos de um dia ainda é a primeira. */
export function bucketOf(dias) {
  if (dias <= 7) return '1-7';
  if (dias <= 15) return '8-15';
  if (dias <= 30) return '16-30';
  return '30+';
}

function asDate(value) {
  if (!value) return null;
  const data = value instanceof Date ? value : new Date(value);
  return Number.isNaN(data.getTime()) ? null : data;
}

const isoOf = (value) => asDate(value)?.toISOString() ?? null;

/**
 * Desde quando o provedor deve. `overdueSince` responde para quem ainda está
 * vivo; o suspenso automático já parou e ela devolve nulo — a conta é refeita
 * com o estado de antes da suspensão (o prazo que venceu continua gravado).
 * Sem nenhuma das duas, o vencimento da cobrança vencida mais antiga.
 */
function devendoDesde(sub, now, { prorationDueAt, oldestOverdueDue }) {
  const comoAntes = isAutoSuspended(sub)
    ? { ...sub, status: sub.renews_at ? 'active' : 'trial', suspended_reason: null }
    : sub;
  const conta = overdueSince(comoAntes, now, { prorationDueAt });
  if (conta) return conta;
  if (oldestOverdueDue) return { since: new Date(`${oldestOverdueDue}T12:00:00Z`), reason: 'charge_overdue' };
  return null;
}

class DelinquencyService {
  /**
   * A lista inteira, com o resumo — os filtros e a ordem são aplicados por
   * `filter`, para o resumo ser sempre o de todos.
   *
   * @returns {Promise<{ rows: object[], summary: object }>}
   */
  static async list({ now = new Date() } = {}) {
    const tenants = await Tenant.list();
    const assinaturas = new Map(
      (await Subscription.listWithPlans()).map((row) => [Number(row.tenant_id), row])
    );
    const planos = new Map((await Plan.list()).map((plan) => [Number(plan.id), plan]));
    const config = await autoSuspendConfig();
    const hoje = ChargeIssuingService.isoDate(now);

    const ids = new Set(tenants.map((tenant) => Number(tenant.id)));
    const abertasDe = new Map();
    for (const row of await BillingCharge.openAcrossTenants()) {
      const id = Number(row.tenant_id);
      if (!ids.has(id)) continue;
      if (!abertasDe.has(id)) abertasDe.set(id, []);
      abertasDe.get(id).push(row);
    }

    const lembretes = await this.reminderIndex([...ids]);

    const rows = [];
    for (const tenant of tenants) {
      const sub = assinaturas.get(Number(tenant.id));
      if (!sub) continue;
      if (sub.billing_exempt_at || sub.status === 'canceled' || isPauseScheduled(sub)) continue;
      const plano = planos.get(Number(sub.plan_id)) ?? null;
      const efetivo = SubscriptionService.effectiveStatus(sub, now);
      if (efetivo.reason === 'paused') continue;

      // As vencidas, por tipo; e as em aberto que ainda vão vencer, à parte.
      const porTipo = Object.fromEntries(CHARGE_KINDS.map((kind) => [kind, 0]));
      let devidoCents = 0;
      let abertoCents = 0;
      let moeda = null;
      let maisAntiga = null;
      const vencidas = [];
      for (const row of abertasDe.get(Number(tenant.id)) ?? []) {
        const centavos = Number(row.amount_cents) || 0;
        abertoCents += centavos;
        moeda = moeda ?? row.currency ?? null;
        const vencimento = isoDateOf(row.due_date);
        if (row.status === 'overdue' || (vencimento && vencimento < hoje)) {
          const tipo = CHARGE_KINDS.includes(row.kind) ? row.kind : 'renewal';
          porTipo[tipo] += centavos;
          devidoCents += centavos;
          vencidas.push(row);
          if (vencimento && (!maisAntiga || vencimento < maisAntiga)) maisAntiga = vencimento;
        }
      }

      const suspensoAuto = isAutoSuspended(sub);
      const atrasado = efetivo.status === 'past_due';
      const cobravel = SubscriptionService.cyclePriceCents(sub, plano) > 0;
      // O atraso de quem não paga nada (plano de graça) não é dívida; a
      // cobrança vencida, de qualquer plano, é.
      const entra = devidoCents > 0 || suspensoAuto || (atrasado && cobravel);
      if (!entra) continue;

      const prorationDueAt = SubscriptionNoticeService.prorationOverdueSince(sub);
      const devendo = devendoDesde(sub, now, { prorationDueAt, oldestOverdueDue: maisAntiga });
      const dias = devendo ? Math.max(0, Math.floor((now.getTime() - devendo.since.getTime()) / DAY_MS)) : 0;

      // A previsão da suspensão automática: a data da conta pura
      // (`since + days`), ou a que a etapa empurrou por falta do aviso.
      let suspensao = null;
      if (!suspensoAuto && sub.status !== 'suspended' && config.days > 0 && cobravel && devendo
        && overdueSince(sub, now, { prorationDueAt })) {
        const chave = ChargeIssuingService.periodKey(devendo.since);
        const warnedAt = lembretes.warned.get(`${tenant.id}:${chave}`) ?? null;
        const etapa = SubscriptionService.autoSuspensionStep(sub, now, plano, config, { prorationDueAt, warnedAt });
        const em = etapa?.suspendAt ?? new Date(devendo.since.getTime() + config.days * DAY_MS);
        suspensao = { at: em.toISOString(), warned: Boolean(warnedAt) };
      }

      rows.push({
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
        status: efetivo.status,
        storedStatus: sub.status,
        suspendedReason: sub.status === 'suspended' ? (sub.suspended_reason ?? null) : null,
        overdueReason: devendo?.reason ?? efetivo.reason ?? null,
        overdueSince: devendo ? devendo.since.toISOString() : null,
        daysOverdue: dias,
        bucket: bucketOf(dias),
        amountCents: devidoCents,
        amountByKind: porTipo,
        openCents: abertoCents,
        currency: moeda ?? sub.plan_currency ?? plano?.currency ?? 'BRL',
        overdueCharges: vencidas.length,
        plan: { id: sub.plan_id ?? null, code: sub.plan_code ?? null, name: sub.plan_name ?? null },
        renewsAt: isoOf(sub.renews_at),
        trialEndsAt: isoOf(sub.trial_ends_at),
        lastReminder: lembretes.last.get(Number(tenant.id)) ?? null,
        autoSuspendAt: suspensao?.at ?? null,
        autoSuspendWarned: suspensao?.warned ?? false,
        card: SubscriptionService.presentCard(sub),
        gateway: {
          gateway: tenant.billing_gateway || null,
          linked: Boolean(tenant.billing_gateway && tenant.billing_customer_ref)
        }
      });
    }

    const byBucket = Object.fromEntries(DELINQUENCY_BUCKETS.map((faixa) => [faixa, 0]));
    const porMoeda = new Map();
    for (const row of rows) {
      byBucket[row.bucket] += 1;
      porMoeda.set(row.currency, (porMoeda.get(row.currency) ?? 0) + row.amountCents);
    }
    const totals = [...porMoeda].map(([currency, cents]) => ({ currency, cents }));
    return {
      rows,
      summary: {
        count: rows.length,
        byBucket,
        totalOverdueCents: totals.reduce((soma, item) => soma + item.cents, 0),
        totalsByCurrency: totals,
        autoSuspendDays: config.days
      }
    };
  }

  /**
   * Os lembretes mandados, numa leitura: o último de cada provedor e quando
   * saiu o aviso de suspensão de cada prazo (para a previsão).
   *
   * O "último" é o de maior id com `sent_at` — a linha nasce na hora do envio,
   * e a ordem de criação é a de envio.
   */
  static async reminderIndex(tenantIds) {
    const last = new Map();
    const warned = new Map();
    if (!tenantIds.length) return { last, warned };
    // tenant-scope-exempt: listagem do plano de controle, acima dos provedores.
    const linhas = await runUnscoped('the console lists every provider\'s last billing reminder', async () => {
      const db = getDb();
      const ultimos = db('subscription_reminder_sends')
        .whereIn('tenant_id', tenantIds)
        .whereNotNull('sent_at')
        .groupBy('tenant_id')
        .max({ id: 'id' });
      const ultimas = await db('subscription_reminder_sends').whereIn('id', ultimos);
      const avisos = await db('subscription_reminder_sends')
        .whereIn('tenant_id', tenantIds)
        .where({ step: 'suspwarn' })
        .whereNotNull('sent_at')
        .select('tenant_id', 'due_at', 'sent_at');
      return { ultimas, avisos };
    });
    const nomes = { suspwarn: 'suspension_warning', suspend: 'suspended' };
    for (const linha of linhas.ultimas) {
      last.set(Number(linha.tenant_id), {
        step: nomes[linha.step] ?? linha.step,
        dueAt: String(linha.due_at).slice(0, 10),
        channels: String(linha.channels ?? '').split(',').filter(Boolean),
        sentAt: isoOf(linha.sent_at)
      });
    }
    for (const linha of linhas.avisos) {
      warned.set(`${linha.tenant_id}:${String(linha.due_at).slice(0, 10)}`, asDate(linha.sent_at));
    }
    return { last, warned };
  }

  /**
   * Os filtros e a ordem da tela: `bucket`, `status` (o estado que vale, ou
   * `auto_suspended`/`manual_suspended`), `q` (nome ou slug) e `sort`
   * (`amount` ou `days`, decrescente por padrão; `order=asc` inverte).
   */
  static filter(rows, { bucket = '', status = '', q = '', sort = '', order = '' } = {}) {
    let saida = rows;
    if (bucket && DELINQUENCY_BUCKETS.includes(bucket)) saida = saida.filter((row) => row.bucket === bucket);
    if (status === 'auto_suspended') {
      saida = saida.filter((row) => row.suspendedReason === SUSPENDED_REASONS.AUTO_NONPAYMENT);
    } else if (status === 'manual_suspended') {
      saida = saida.filter((row) => row.status === 'suspended' && row.suspendedReason !== SUSPENDED_REASONS.AUTO_NONPAYMENT);
    } else if (status) {
      saida = saida.filter((row) => row.status === status);
    }
    const busca = String(q ?? '').trim().toLowerCase();
    if (busca) {
      saida = saida.filter((row) => String(row.tenant.name ?? '').toLowerCase().includes(busca)
        || String(row.tenant.slug ?? '').toLowerCase().includes(busca));
    }
    const sinal = order === 'asc' ? 1 : -1;
    const chave = sort === 'amount' ? 'amountCents' : 'daysOverdue';
    const segunda = chave === 'amountCents' ? 'daysOverdue' : 'amountCents';
    return [...saida].sort((a, b) => (sinal * (a[chave] - b[chave]))
      || (sinal * (a[segunda] - b[segunda]))
      || (Number(a.tenant.id) - Number(b.tenant.id)));
  }

  /**
   * UMA ação sobre UM provedor. Nunca lança pelo que é recusa conhecida: o
   * resultado diz `{ ok, code }`, e `audit` o que a trilha deve gravar
   * (quem chama grava, com a requisição na mão). Erro inesperado lança, e
   * quem chama o transforma em `{ ok: false, code: 'error' }` sem parar os
   * outros.
   *
   * @returns {Promise<{ ok: boolean, code: string, audit?: object, detail?: object }>}
   */
  static async runAction({ tenant, action, params = {}, actorUserId = null, now = new Date() }) {
    const sub = await Subscription.forTenant(tenant.id);
    if (!sub) return { ok: false, code: 'subscription_not_found' };
    if (sub.status === 'canceled') return { ok: false, code: 'subscription_canceled' };
    const reason = params.reason ?? null;

    if (action === 'remind') {
      const enviado = await runInTenant(tenant.id, () => SubscriptionNoticeService.remindNow({ now, tenant }));
      if (!enviado.sent) {
        return { ok: false, code: enviado.reason, ...(enviado.retryAt ? { detail: { retryAt: enviado.retryAt } } : {}) };
      }
      return {
        ok: true,
        code: 'sent',
        audit: {
          platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_REMINDER_SENT,
          detail: { manual: true, bulk: true, recipients: enviado.recipients, whatsapp: enviado.whatsapp }
        }
      };
    }

    if (action === 'suspend') {
      if (sub.status === 'suspended') return { ok: false, code: 'already_suspended' };
      await runInTenant(tenant.id, () => SubscriptionService.setStatus({
        status: 'suspended', reason, actorUserId, suspendedReason: SUSPENDED_REASONS.MANUAL
      }));
      return {
        ok: true,
        code: 'suspended',
        audit: {
          platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_STATUS_CHANGED,
          detail: { from: sub.status, to: 'suspended', reason, suspendedReason: SUSPENDED_REASONS.MANUAL, bulk: true }
        }
      };
    }

    if (action === 'exempt') {
      if (sub.billing_exempt_at) return { ok: false, code: 'already_exempt' };
      let resultado;
      try {
        resultado = await SubscriptionService.setBillingExempt({
          tenantId: tenant.id, exempt: true, reason, until: params.until ?? null, actorUserId, now
        });
      } catch (error) {
        if (error instanceof BillingExemptError) return { ok: false, code: error.code };
        throw error;
      }
      if (resultado.alreadyInState) return { ok: false, code: 'already_exempt' };
      const detail = {
        exempt: true,
        reason,
        until: resultado.subscription?.billing_exempt_until
          ? new Date(resultado.subscription.billing_exempt_until).toISOString() : null,
        statusBefore: resultado.statusBefore,
        statusAfter: resultado.statusAfter,
        canceledCharges: resultado.canceledCharges,
        ...(resultado.failedCharges.length ? { chargesLeftOpen: resultado.failedCharges } : {}),
        ...(resultado.reopenedCharge ? { reopenedCharge: true } : {}),
        renewsAt: resultado.subscription?.renews_at ?? null,
        bulk: true
      };
      // O motivo é anotação interna do console: só na trilha da plataforma.
      const { reason: _motivo, ...tenantDetail } = detail;
      return {
        ok: true,
        code: 'exempted',
        detail: { canceledCharges: resultado.canceledCharges, failedCharges: resultado.failedCharges.length },
        audit: { platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_BILLING_EXEMPT_CHANGED, detail, tenantDetail }
      };
    }

    if (action === 'extend') {
      const extendDays = Number(params.days);
      // A cortesia é a única ação em massa que NÃO é idempotente por si: o
      // mesmo pedido repetido (o navegador que desistiu de esperar duzentos
      // provedores e a pessoa que clicou de novo) daria o prazo duas vezes.
      // Com `requestId`, o pedido deixa a marca no extrato e a repetição vira
      // "já feito" — a conferência antes poupa o gateway, e o índice único
      // segura a corrida.
      const externalId = params.requestId ? `delinq-extend:${params.requestId}` : null;
      const jaFeito = () => ({ ok: true, code: 'extended', detail: { duplicate: true } });
      if (externalId) {
        const marca = await runInTenant(tenant.id, () => tdb('billing_events').where({ external_id: externalId }).first('id'));
        if (marca) return jaFeito();
      }
      let depois;
      try {
        depois = await runInTenant(tenant.id, () => SubscriptionService.setDeadlines({
          extendDays, reason, actorUserId, now, externalId
        }));
      } catch (error) {
        // A cobrança em aberto não acompanhou o prazo (o gateway recusou), e
        // o prazo não se moveu.
        if (error instanceof ChargeFollowError) return { ok: false, code: error.code };
        if (externalId && isUniqueViolation(error)) return jaFeito();
        throw error;
      }
      return {
        ok: true,
        code: 'extended',
        detail: { renewsAt: isoOf(depois.renews_at), trialEndsAt: isoOf(depois.trial_ends_at) },
        audit: {
          platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_DEADLINE_CHANGED,
          detail: {
            extendDays,
            from: { renewsAt: sub.renews_at ?? null, trialEndsAt: sub.trial_ends_at ?? null },
            to: { renewsAt: depois.renews_at ?? null, trialEndsAt: depois.trial_ends_at ?? null },
            status: sub.status,
            reason,
            bulk: true
          }
        }
      };
    }

    return { ok: false, code: 'invalid_action' };
  }
}

export default DelinquencyService;

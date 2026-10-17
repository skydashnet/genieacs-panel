import Tenant from '../models/Tenant.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import Coupon from '../models/Coupon.js';
import BillingCharge, { OPEN_CHARGE_STATUSES, isoDateOf, isProration } from '../models/BillingCharge.js';
import BillingInvoice from '../models/BillingInvoice.js';
import BillingInvoiceService, { InvoiceRequestError } from '../services/billing/billingInvoiceService.js';
import PlatformAudit from '../models/PlatformAudit.js';
import BillingEvent from '../models/BillingEvent.js';
import TenantCredit from '../models/TenantCredit.js';
import SubscriptionService, { isBillableStatus } from '../services/subscriptionService.js';
import ChargeIssuingService, { ChargeFollowError } from '../services/chargeIssuingService.js';
import { providerFor } from '../services/billing/registry.js';
import { AsaasError } from '../services/billing/asaasClient.js';
import { runInTenant } from '../config/tenantContext.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { recordBoth, subscriptionView } from './platformBillingController.js';

/**
 * A tela de Assinaturas do console: todos os provedores de uma vez, com o que
 * cada um deve, e os gestos sobre UMA cobrança — dar baixa, cancelar, mudar
 * vencimento ou valor, reemitir, estornar — mais o prazo mexido à mão.
 *
 * O resto do que se faz com uma assinatura (trocar o plano, suspender,
 * reativar) continua em `PUT /tenants/:id/subscription`, que já existia: esta
 * tela o chama em vez de ganhar uma segunda porta para a mesma coisa.
 *
 * ## As mesmas regras de `PlatformBillingController`
 *
 * Toda escrita acontece NO ESCOPO do provedor (`runInTenant`), e é isso que
 * torna o id da cobrança seguro: `BillingCharge.findById` lê por `tdb`, então
 * o id de uma cobrança do vizinho, pedido pela URL de outro provedor,
 * simplesmente não é achado — 404, e não "a cobrança certa do provedor
 * errado". E cada gesto grava nas duas trilhas (`recordBoth`): a nossa diz o
 * que fizemos, a do provedor diz o que aconteceu com ele.
 *
 * ## A garra, de novo
 *
 * Toda escrita sobre uma cobrança em aberto toma a linha antes
 * (`BillingCharge.claim` com `unissued: false`) e a solta depois — a mesma
 * garra da emissão e da troca de plano. Sem ela, o agendador (ou o "pagar
 * agora" do provedor) poderia estar reemitindo exatamente a linha que o
 * console está cancelando, e as duas escritas se cruzariam no gateway. Quem
 * perde a garra ouve `busy`, e tenta de novo em instantes.
 */

/** O prazo curto da garra do console: uma chamada ao gateway e duas escritas. */
const CLAIM_MS = ChargeIssuingService.CLAIM_MS;

/** Uma recusa com status e código, lançada de dentro do escopo e respondida fora. */
class ConsoleChargeError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** `YYYY-MM-DD` de verdade — o formato E um dia que existe (`2026-02-30` não). */
function parseIsoDay(value) {
  const texto = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const data = new Date(`${texto}T12:00:00Z`);
  if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== texto) return null;
  return texto;
}

/** Hoje, no fuso em que a cobrança é lida — o mesmo da emissão. */
function hoje(now = new Date()) {
  return ChargeIssuingService.isoDate(now);
}

/**
 * O provedor da URL, ou a resposta já dada.
 *
 * A caixa da plataforma responde 404 como um id que não existe, e não 400 nem
 * 409: ela não é cliente, não tem assinatura a mostrar nem cobrança a mexer,
 * e para esta tela ela simplesmente não está lá — é o mesmo recorte de
 * `Tenant.list()`, que a deixa fora da listagem.
 */
async function tenantOr404(req, res) {
  const id = parseId(req.params?.id);
  if (!id) {
    res.status(400).json(createErrorResponse('Invalid provider id'));
    return null;
  }
  const tenant = await Tenant.findById(id);
  if (!tenant || tenant.kind === 'platform') {
    res.status(404).json(createErrorResponse('Provider not found'));
    return null;
  }
  return tenant;
}

function responderRecusa(res, error) {
  return res.status(error.status).json({
    ...createErrorResponse(error.message, null, error.code),
    // Os campos nomeados no TOPO, como o 409 de `recordPayment`: o cliente de
    // API encaminha campo nomeado num erro, não o `data` inteiro.
    ...error.extra
  });
}

/** Uma cobrança como o console a vê, com a NFS-e dela — lida no escopo do dono. */
async function chargeView(tenantId, row) {
  if (!row) return null;
  const nota = await runInTenant(tenantId, () => BillingInvoice.forCharge(row.id));
  return BillingCharge.presentForConsole(row, nota);
}

/** A recusa de `ChargeIssuingService.followDeadline`, no mesmo formato das outras. */
function responderFollow(res, error) {
  return res.status(error.status).json({
    ...createErrorResponse(error.message, null, error.code),
    ...(error.detail ? { detail: error.detail } : {})
  });
}

/**
 * A cobrança da URL, dentro do escopo do provedor, e EM ABERTO.
 *
 * As duas recusas na ordem em que alguém as entende: primeiro "não existe"
 * (inclusive a do vizinho, que daqui não se vê), depois "existe, mas já
 * fechou" — paga, cancelada ou estornada não tem baixa, cancelamento nem
 * vencimento a mudar.
 */
async function cobrancaEmAberto(chargeId) {
  const cobranca = await BillingCharge.findById(chargeId);
  if (!cobranca) throw new ConsoleChargeError(404, 'Charge not found', 'not_found');
  if (!OPEN_CHARGE_STATUSES.includes(cobranca.status)) {
    throw new ConsoleChargeError(409, `The charge is ${cobranca.status}, not open`, 'not_open', {
      status: cobranca.status
    });
  }
  return cobranca;
}

/**
 * Toma a linha para o console — só se ela AINDA está em aberto —, ou recusa.
 *
 * `openOnly` na própria garra: a leitura que disse "em aberto" e o `UPDATE`
 * que toma a linha são dois comandos, e entre eles o webhook pode tê-la
 * quitado. Quem não tomou relê para dizer o motivo certo: fechada é
 * `not_open`, ocupada é `busy`.
 */
async function tomar(cobranca, now = new Date()) {
  const minha = await BillingCharge.claim(cobranca.id, {
    until: new Date(now.getTime() + CLAIM_MS), now, unissued: false, openOnly: true
  });
  if (minha) return;
  const agora = await BillingCharge.findById(cobranca.id);
  if (agora && !OPEN_CHARGE_STATUSES.includes(agora.status)) {
    throw new ConsoleChargeError(409, `The charge is ${agora.status}, not open`, 'not_open', { status: agora.status });
  }
  throw new ConsoleChargeError(409, 'The charge is being changed by another process; try again shortly', 'busy');
}

/**
 * Os estados do gateway em que o dinheiro JÁ entrou por lá. Conferido contra
 * a documentação da Asaas em setembro de 2026: `CONFIRMED` (cartão aprovado,
 * boleto compensando), `RECEIVED` (caiu na conta) e `RECEIVED_IN_CASH` (a
 * baixa manual feita lá dentro).
 */
const RECEBIDA_NO_GATEWAY = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

/**
 * O estado do gateway em que o dinheiro JÁ VOLTOU, e é final: o estorno
 * pedido no painel da Asaas, ou por uma tentativa anterior deste botão cuja
 * resposta se perdeu. Pedir o estorno de novo seria recusado; o console segue
 * sem ele e desfaz só o lado de cá. Conferido contra a documentação da Asaas
 * em setembro de 2026.
 */
const ESTORNADA_NO_GATEWAY = new Set(['REFUNDED']);

/**
 * Os estados em que o estorno foi PEDIDO e ainda não terminou
 * (`REFUND_REQUESTED`, `REFUND_IN_PROGRESS`). Não são finais — a Asaas ainda
 * pode negar (`PAYMENT_REFUND_DENIED`, que o webhook registra aos gritos) —,
 * mas o console segue do mesmo jeito: o dinheiro está a caminho de volta, pedir
 * de novo seria recusado, e deixar o período valendo enquanto ele volta seria
 * entregar o que já está sendo devolvido. A trilha diz qual dos dois foi
 * (`atGateway: 'refund_in_progress'`), para quem for conferir a negativa.
 */
const ESTORNO_A_CAMINHO = new Set(['REFUND_REQUESTED', 'REFUND_IN_PROGRESS']);

/**
 * Os gestos em que ESTA requisição moveu o dinheiro no gateway. Com eles, um
 * estorno que o extrato já tem (`duplicate`) não é "já estornado": é o
 * `PAYMENT_REFUNDED` do próprio gesto chegando antes da resposta — e a tela
 * precisa dizer que estornou, não que alguém estornou antes.
 */
const GESTOS_QUE_MOVEM = new Set(['refunded', 'undo_received_in_cash']);

/**
 * A baixa de uma cobrança cuja referência JÁ tem pagamento no extrato — o
 * webhook chegou antes, ou numa corrida com esta mesma requisição.
 *
 * Dois casos, e a diferença é o que o registro anterior fez com o período:
 *
 *   - **Creditou** (pagamento cheio, ou a menos já aceito): a baixa só fecha
 *     a linha e responde `duplicate: true`. Nenhum segundo crédito.
 *   - **Registrou a menos e NÃO estendeu** (`detail.underpaid`): fechar a
 *     linha como paga aqui esconderia de "o que está em aberto" um período
 *     que ninguém pagou inteiro. A baixa recusa (`already_recorded_underpaid`,
 *     com quanto entrou e quanto se pedia) — e só com `allowUnderpayment`
 *     aceita a diferença.
 *
 * ## Aceitar a diferença sem poder creditar duas vezes
 *
 * O aceite é um SEGUNDO evento, com a referência `<referência>:accepted` e
 * valor zero — zero porque o dinheiro já está no extrato, no evento do
 * webhook, e somá-lo de novo mentiria sobre quanto o provedor mandou. É ele
 * que estende o período, por `recordPayment` com `allowUnderpayment`, e é a
 * mesma idempotência de sempre que o faz valer uma vez só: a referência é
 * única por provedor, e um segundo aceite cai como `duplicate` — tanto na
 * leitura quanto no índice, numa corrida de dois cliques.
 */
async function fecharPeloRegistro(evento, { cobranca, externalId, allowUnderpayment, actorUserId, now }) {
  let detalhe = null;
  try { detalhe = evento?.detail ? JSON.parse(evento.detail) : null; } catch { detalhe = null; }
  let aceitou = false;
  if (detalhe?.underpaid) {
    const referenciaDoAceite = `${externalId}:accepted`;
    if (!(await BillingEvent.findByExternalId(referenciaDoAceite))) {
      if (!allowUnderpayment) {
        throw new ConsoleChargeError(
          409,
          'A short payment was already recorded for this charge; accept the difference to settle it',
          'already_recorded_underpaid',
          {
            paidCents: Number(evento.amount_cents ?? 0),
            expectedCents: detalhe.expectedCents ?? Number(cobranca.amount_cents),
            currency: evento.currency || cobranca.currency
          }
        );
      }
      const aceite = await SubscriptionService.recordPayment({
        amountCents: 0,
        currency: evento.currency || cobranca.currency,
        provider: 'manual',
        externalId: referenciaDoAceite,
        actorUserId,
        allowUnderpayment: true,
        now,
        // A referência do aceite não acha cobrança nenhuma; a de pró-rata
        // (0101) é nomeada, para o aceite não estender o período como se
        // fosse a renovação.
        ...(isProration(cobranca) ? { chargeId: cobranca.id } : {})
      });
      aceitou = !aceite.duplicate;
    }
  }
  await BillingCharge.update(cobranca.id, { status: 'paid', last_error: null, issuing_until: null });
  // A NFS-e, como na baixa comum: a cobrança paga agora — inclusive a que
  // fechou aceitando um pagamento a menos — tem nota, do valor que de fato
  // entrou (ver `billingInvoiceService`). Idempotente: a reentrega que já
  // tinha enfileirado não abre outra.
  if (cobranca.gateway_charge_id) {
    await BillingInvoiceService.enqueueForCharge({ ...cobranca, status: 'paid' });
  }
  return {
    cobranca,
    externalId,
    duplicate: !aceitou,
    acceptedUnderpayment: aceitou,
    gateway: false,
    alreadyReceivedAtGateway: false,
    charge: await BillingCharge.findById(cobranca.id),
    state: await SubscriptionService.current()
  };
}

/**
 * A chamada ao gateway, com a recusa dele traduzida.
 *
 * 502 e `gateway_failed`, como no "pagar agora" do provedor: o pedido estava
 * certo, quem falhou foi o sistema de fora. O motivo do gateway vai em
 * `detail`, porque quem lê esta tela opera a conta de lá e é o texto dele que
 * resolve o chamado.
 */
async function noGateway(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AsaasError) {
      throw new ConsoleChargeError(502, `The payment gateway refused: ${error.message}`, 'gateway_failed', {
        detail: error.message
      });
    }
    throw error;
  }
}

/**
 * O provider que fala pela LINHA, se ela tem o que falar com ele.
 *
 * Pela linha e não pelo provedor: é o gateway que EMITIU esta cobrança quem
 * sabe dela, mesmo que o provedor tenha sido religado a outro depois. Sem id
 * do lado de lá, ou com um provider que não sabe fazer o gesto (o `manual`),
 * não há chamada nenhuma — o console mexe só do lado de cá.
 */
function gatewayDa(cobranca, metodo) {
  if (!cobranca.gateway_charge_id) return null;
  const provider = providerFor(cobranca.provider);
  return provider && typeof provider[metodo] === 'function' ? provider : null;
}

class PlatformSubscriptionsController {
  /**
   * `GET /api/platform/subscriptions` — todos os provedores, com a assinatura,
   * o vínculo com o gateway e a cobrança em aberto mais recente.
   *
   * Quatro consultas, sempre, e nenhuma por provedor: os provedores, as
   * assinaturas com o plano (`Subscription.listWithPlans`), o catálogo (para a
   * descida agendada) e as cobranças em aberto de todos
   * (`BillingCharge.openAcrossTenants`). As duas escopadas são lidas sem
   * escopo com a razão escrita no modelo — é a única tela do produto em que
   * ver todos de uma vez é o trabalho.
   *
   * O estado de cada um é o que VALE (`effectiveStatus`), não o gravado: um
   * `active` com a renovação vencida é `past_due` para o gate, e a lista que
   * dissesse outra coisa esconderia exatamente quem precisa ser cobrado. O
   * gravado viaja ao lado (`storedStatus`) para quem precisar dos dois.
   */
  static async listSubscriptions(req, res) {
    try {
      const now = new Date();
      const tenants = await Tenant.list();
      const assinaturas = new Map(
        (await Subscription.listWithPlans()).map((row) => [Number(row.tenant_id), row])
      );
      const planos = new Map((await Plan.list()).map((plan) => [Number(plan.id), plan]));
      // Os cupons (0093), numa leitura só: a linha mostra o selo e o preço com
      // desconto (`effectivePriceCents`, na versão que recebe o cupom pronto).
      const cupons = new Map((await Coupon.list()).map((cupom) => [Number(cupom.id), cupom]));
      const ids = new Set(tenants.map((tenant) => Number(tenant.id)));

      // A mais recente em aberto de cada um (a lista vem por `period_end`
      // decrescente, então a primeira vista é a que fica) — a mesma escolha de
      // `BillingCharge.currentOpen`, que é a que o aviso de vencimento linka.
      const abertas = (await BillingCharge.openAcrossTenants())
        .filter((row) => ids.has(Number(row.tenant_id)));
      const abertaDe = new Map();
      for (const row of abertas) {
        if (!abertaDe.has(Number(row.tenant_id))) abertaDe.set(Number(row.tenant_id), row);
      }

      const byStatus = { trial: 0, active: 0, past_due: 0, suspended: 0, canceled: 0, none: 0 };
      // Os isentos de cobrança contam À PARTE e TAMBÉM no estado deles (que é
      // `active`, por `effectiveStatus`): o resumo responde "quantos estão
      // ativos" e "quantos não pagam" — duas perguntas, dois números.
      let exempt = 0;
      const rows = tenants.map((tenant) => {
        const sub = assinaturas.get(Number(tenant.id)) || null;
        const status = sub ? SubscriptionService.effectiveStatus(sub, now).status : null;
        byStatus[status && status in byStatus ? status : 'none'] += 1;
        if (sub?.billing_exempt_at) exempt += 1;
        const pendente = sub?.pending_plan_id ? planos.get(Number(sub.pending_plan_id)) : null;
        return {
          tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
          subscription: sub ? {
            status,
            storedStatus: sub.status,
            // A suspensão automática por inadimplência (0102) ganha selo próprio.
            suspendedReason: sub.status === 'suspended' ? (sub.suspended_reason ?? null) : null,
            planId: sub.plan_id ?? null,
            planCode: sub.plan_code ?? null,
            planName: sub.plan_name ?? null,
            // O preço de UM ciclo (0104) — o do ano, no anual — e o ciclo.
            priceCents: planos.get(Number(sub.plan_id))
              ? SubscriptionService.cyclePriceCents(sub, planos.get(Number(sub.plan_id)))
              : Number(sub.plan_price_cents ?? 0),
            billingCycle: SubscriptionService.cycleOf(sub, planos.get(Number(sub.plan_id)) ?? null),
            currency: sub.plan_currency ?? null,
            trialEndsAt: sub.trial_ends_at ?? null,
            renewsAt: sub.renews_at ?? null,
            pendingPlan: SubscriptionService.presentPendingPlan(sub, pendente),
            coupon: SubscriptionService.presentCoupon(
              sub, planos.get(Number(sub.plan_id)) ?? null, sub.coupon_id ? cupons.get(Number(sub.coupon_id)) ?? null : null
            ),
            // O cartão recorrente (0100): bandeira e dígitos, nunca o token.
            card: SubscriptionService.presentCard(sub),
            // A retenção (0107): os selos "Cancela em" e "Pausada até".
            ...SubscriptionService.presentRetention(sub),
            ...SubscriptionService.presentBillingExempt(sub, { withReason: true })
          } : null,
          // SE há vínculo, e nunca o id do cliente no gateway — a mesma regra
          // da trilha (`TENANT_GATEWAY_CHANGED`): é a chave que decide para
          // quem vai o crédito, e uma lista é lida por mais gente que a ficha.
          gateway: {
            gateway: tenant.billing_gateway || null,
            linked: Boolean(tenant.billing_gateway && tenant.billing_customer_ref)
          },
          openCharge: BillingCharge.presentForConsole(abertaDe.get(Number(tenant.id)) || null)
        };
      });

      // O total é de TODAS as em aberto, e não só da mais recente de cada um:
      // a pergunta é "quanto temos a receber", e uma cobrança velha esquecida
      // em aberto é dinheiro a receber como qualquer outra. Atrasada é a que
      // o gateway chamou de `overdue` OU a que passou do vencimento sem que o
      // aviso dele tenha chegado — contar só a etiqueta deixaria de fora quem
      // o webhook ainda não alcançou.
      const dia = hoje(now);
      let openTotalCents = 0;
      let overdueCount = 0;
      for (const row of abertas) {
        openTotalCents += Number(row.amount_cents) || 0;
        const vencimento = isoDateOf(row.due_date);
        if (row.status === 'overdue' || (vencimento && vencimento < dia)) overdueCount += 1;
      }

      // O filtro da tela (`?status=`): o estado que VALE, `none` para quem não
      // tem assinatura, ou `exempt` para os isentos de cobrança. O resumo é
      // sempre de todos — é ele que mostra quantos há em cada filtro.
      const filtro = String(req.query?.status ?? '').trim();
      let visiveis = rows;
      if (filtro === 'exempt') {
        visiveis = rows.filter((row) => row.subscription?.billingExempt);
      } else if (filtro && Object.hasOwn(byStatus, filtro)) {
        visiveis = rows.filter((row) => (row.subscription?.status ?? 'none') === filtro);
      }

      return res.json(createResponse('Subscriptions retrieved', {
        rows: visiveis,
        summary: { byStatus, exempt, openTotalCents, overdueCount }
      }));
    } catch (error) {
      console.error('List subscriptions error:', error);
      return res.status(500).json(createErrorResponse('Failed to list the subscriptions', error.message));
    }
  }

  /** `GET /api/platform/tenants/:id/charges` — as 24 mais recentes, como o console as vê. */
  static async listCharges(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      // Vinte e quatro: dois anos de um plano mensal, que é o horizonte em que
      // alguém ainda pergunta "esse mês foi pago?". Mais que isso é histórico,
      // e o histórico mora no extrato.
      const { linhas, notas } = await runInTenant(tenant.id, async () => {
        const lidas = await BillingCharge.listRecent({ limit: 24 });
        return { linhas: lidas, notas: await BillingInvoice.forCharges(lidas.map((row) => row.id)) };
      });
      return res.json(createResponse('Charges retrieved', {
        charges: linhas.map((row) => BillingCharge.presentForConsole(row, notas.get(Number(row.id)) || null))
      }));
    } catch (error) {
      console.error('List charges error:', error);
      return res.status(500).json(createErrorResponse('Failed to list the charges', error.message));
    }
  }

  /**
   * `PATCH /api/platform/tenants/:id/subscription/deadlines` — a cortesia de
   * alguns dias (`extendDays`) ou a data exata (`renewsAt`, `trialEndsAt`).
   * Uma forma por pedido: somar dias E fixar a data ao mesmo tempo não tem
   * leitura que não seja um palpite sobre qual das duas se quis.
   *
   * Responde o mesmo que `GET /tenants/:id/subscription`, para a tela trocar
   * o que mostra sem ter de perguntar de novo.
   */
  static async setDeadlines(req, res) {
    try {
      const body = req.body ?? {};
      const temData = body.renewsAt !== undefined || body.trialEndsAt !== undefined;
      const temDias = body.extendDays !== undefined && body.extendDays !== null;
      if (!temData && !temDias) {
        return res.status(400).json(createErrorResponse('Nothing to update'));
      }
      if (temData && temDias) {
        return res.status(400).json(createErrorResponse('Send either extendDays or explicit dates, not both'));
      }
      let extendDays = null;
      if (temDias) {
        extendDays = Number(body.extendDays);
        if (!Number.isInteger(extendDays) || extendDays < 1 || extendDays > 365) {
          return res.status(400).json(createErrorResponse('extendDays must be an integer between 1 and 365'));
        }
      }
      if (body.renewsAt !== undefined
        && (body.renewsAt === null || Number.isNaN(new Date(body.renewsAt).getTime()))) {
        return res.status(400).json(createErrorResponse('renewsAt must be a date'));
      }
      if (body.trialEndsAt !== undefined && body.trialEndsAt !== null
        && Number.isNaN(new Date(body.trialEndsAt).getTime())) {
        return res.status(400).json(createErrorResponse('trialEndsAt must be a date or null'));
      }
      const reason = body.reason ? String(body.reason).slice(0, 255) : null;

      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const before = await Subscription.forTenant(tenant.id);
      if (!before) return res.status(404).json(createErrorResponse('Subscription not found'));

      let after;
      try {
        after = await runInTenant(tenant.id, () => SubscriptionService.setDeadlines({
          renewsAt: body.renewsAt,
          trialEndsAt: body.trialEndsAt,
          extendDays,
          reason,
          actorUserId: req.user?.userId ?? null
        }));
      } catch (error) {
        // A cobrança em aberto não pôde acompanhar o prazo (o gateway recusou,
        // ou a linha é de outra passada) — e o prazo não se moveu.
        if (error instanceof ChargeFollowError) return responderFollow(res, error);
        throw error;
      }

      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_DEADLINE_CHANGED,
        detail: {
          ...(extendDays ? { extendDays } : {}),
          from: { renewsAt: before.renews_at ?? null, trialEndsAt: before.trial_ends_at ?? null },
          to: { renewsAt: after.renews_at ?? null, trialEndsAt: after.trial_ends_at ?? null },
          status: before.status,
          reason
        }
      });
      return res.json(createResponse('Deadlines updated', await subscriptionView(tenant)));
    } catch (error) {
      console.error('Set deadlines error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the deadlines', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/charges/:chargeId/settle` — o provedor
   * pagou por fora, e alguém dá baixa na cobrança.
   *
   * ## A ordem é o que importa
   *
   *   0. **A assinatura parada por gente** (`suspended`, `canceled`) recusa
   *      com `subscription_inactive`, a menos que venha `force: true`. O
   *      pagamento seria registrado e o período NÃO andaria (é a regra de
   *      `recordPayment`: pagamento não reativa quem alguém desligou) — e uma
   *      baixa que fecha a cobrança sem mudar nada no acesso é a surpresa que
   *      a pessoa precisa ver antes, e não depois. A suspensão AUTOMÁTICA
   *      por inadimplência (0102) não é "parada por gente": o pagamento a
   *      reativa, e a baixa passa.
   *   1. **A garra**, antes de qualquer leitura que decida: ninguém reemite,
   *      cancela ou quita esta linha no meio.
   *   2. **O que já foi registrado por esta referência.** O webhook pode ter
   *      creditado (e aí não há o que fazer além de fechar a linha) ou ter
   *      registrado um pagamento A MENOS, que não estendeu nada — aí a baixa
   *      responde `already_recorded_underpaid`, e só com `allowUnderpayment`
   *      aceita a diferença (ver `fecharPeloRegistro`).
   *   3. **A conferência do valor**, contra o valor DA COBRANÇA, antes do
   *      gateway. Se ela recusasse depois, a Asaas já teria a cobrança como
   *      recebida — o provedor veria "pago" lá e "em aberto" aqui.
   *   4. **O gateway.** Primeiro a LEITURA (`getCharge`): se a Asaas já tem a
   *      cobrança como recebida (o webhook se perdeu), o `receiveInCash` seria
   *      recusado para sempre, e a baixa segue sem ele. Senão, o
   *      `receiveInCash`. Qualquer recusa: 502, e NADA é gravado.
   *   5. **O crédito**, por `SubscriptionService.recordPayment` — a mesma porta
   *      do webhook, com a mesma idempotência. A referência é o id da cobrança
   *      no gateway, e é isso que faz o `PAYMENT_RECEIVED` que a Asaas manda
   *      depois cair como `duplicate`. Sem id no gateway, `charge:<id>`.
   *   6. **A linha vira `paid`**, e a garra sai.
   *
   * ## O período conta do prazo, não de `paidAt`
   *
   * `paidAt` vai ao gateway (é a data do recebimento lá) e à trilha. O período
   * que o pagamento compra é o de sempre em `recordPayment`: a partir do maior
   * entre o prazo atual e agora. Contar de `paidAt` daria a quem pagou há dez
   * dias e só agora teve a baixa dez dias a menos — ou, com uma data errada
   * digitada, dias de graça a mais —, e a regra deixaria de ser a mesma do
   * webhook, que é a que o provedor conhece.
   */
  static async settle(req, res) {
    try {
      const body = req.body ?? {};
      const paidAt = parseIsoDay(body.paidAt);
      if (!paidAt) return res.status(400).json(createErrorResponse('paidAt must be a date as YYYY-MM-DD'));
      const now = new Date();
      // Um recebimento no futuro não é um recebimento, e o gateway recusaria
      // do mesmo jeito — só que depois da garra e com um texto pior.
      if (paidAt > hoje(now)) return res.status(400).json(createErrorResponse('paidAt cannot be in the future'));
      const amount = Number(body.amountCents);
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json(createErrorResponse('amountCents must be a positive integer'));
      }
      const allowUnderpayment = body.allowUnderpayment === true;
      const force = body.force === true;
      const note = body.note ? String(body.note).slice(0, 255) : null;
      const chargeId = parseId(req.params?.chargeId);
      if (!chargeId) return res.status(400).json(createErrorResponse('Invalid charge id'));

      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const actorUserId = req.user?.userId ?? null;

      let resultado;
      try {
        resultado = await runInTenant(tenant.id, async () => {
          const cobranca = await cobrancaEmAberto(chargeId);
          const assinatura = await Subscription.forTenant(tenant.id);
          // A suspensão AUTOMÁTICA (0102) passa: o pagamento a reativa.
          if (!force && assinatura && !isBillableStatus(assinatura)
            && (assinatura.status === 'suspended' || assinatura.status === 'canceled')) {
            throw new ConsoleChargeError(
              409,
              `The subscription is ${assinatura.status}: a payment would not extend it (send force to settle anyway)`,
              'subscription_inactive',
              { subscriptionStatus: assinatura.status }
            );
          }

          await tomar(cobranca, now);
          try {
            const externalId = cobranca.gateway_charge_id || `charge:${cobranca.id}`;
            const contexto = { cobranca, externalId, allowUnderpayment, actorUserId, now };

            // `return await`, e não só `return`, nos dois pontos: dentro de um
            // `try/finally` a promessa devolvida sem espera fica pendurada
            // enquanto o `finally` solta a garra — a garra sairia antes de a
            // baixa terminar, e a recusa dela viraria rejeição sem dono.
            const anterior = await BillingEvent.findByExternalId(externalId);
            if (anterior) return await fecharPeloRegistro(anterior, contexto);

            const pedido = Number(cobranca.amount_cents);
            if (amount < pedido && !allowUnderpayment) {
              throw new ConsoleChargeError(409, 'The amount is short of what was charged', 'underpaid', {
                paidCents: amount, expectedCents: pedido, currency: cobranca.currency
              });
            }

            const gateway = gatewayDa(cobranca, 'receiveInCash');
            let jaRecebida = false;
            if (gateway) {
              if (typeof gateway.getCharge === 'function') {
                const situacao = await noGateway(() => gateway.getCharge(cobranca.gateway_charge_id));
                jaRecebida = RECEBIDA_NO_GATEWAY.has(String(situacao?.status ?? '').toUpperCase());
              }
              if (!jaRecebida) {
                await noGateway(() => gateway.receiveInCash(cobranca.gateway_charge_id, {
                  paymentDate: paidAt, value: amount
                }));
              }
            }

            const pagamento = await SubscriptionService.recordPayment({
              amountCents: amount,
              currency: cobranca.currency,
              provider: 'manual',
              externalId,
              actorUserId,
              allowUnderpayment,
              now
            });
            // A corrida com o webhook: ele gravou esta referência entre a
            // leitura lá em cima e aqui. O registro dele é o que vale.
            if (pagamento.duplicate) {
              return await fecharPeloRegistro(await BillingEvent.findByExternalId(externalId), contexto);
            }
            if (pagamento.underpaid) {
              // Só numa corrida: a conferência lá em cima olhou a MESMA linha.
              // Se chegou aqui, o valor dela mudou entre as duas leituras — e o
              // gateway, se havia, já recebeu. Dito em voz alta, porque é o
              // único caminho em que os dois lados podem discordar.
              console.warn(
                `Console settlement of charge ${cobranca.id} (provider ${tenant.id}) came out short `
                + `after the gateway call: ${amount} of ${pagamento.expectedCents} cents`
              );
              throw new ConsoleChargeError(409, 'The amount is short of what was charged', 'underpaid', {
                paidCents: amount, expectedCents: pagamento.expectedCents, currency: cobranca.currency
              });
            }
            await BillingCharge.update(cobranca.id, { status: 'paid', last_error: null, issuing_until: null });
            // A NFS-e na fila — só a da cobrança que passou pelo gateway (a
            // baixa sem id lá não tem pagamento da Asaas a que a nota aponte).
            // Sem falar com a Asaas aqui, e sem poder derrubar a baixa.
            if (cobranca.gateway_charge_id) {
              await BillingInvoiceService.enqueueForCharge({ ...cobranca, status: 'paid' });
            }
            return {
              cobranca,
              externalId,
              duplicate: false,
              acceptedUnderpayment: false,
              gateway: Boolean(gateway),
              alreadyReceivedAtGateway: jaRecebida,
              charge: await BillingCharge.findById(cobranca.id),
              state: await SubscriptionService.current()
            };
          } finally {
            await BillingCharge.release(cobranca.id);
          }
        });
      } catch (error) {
        if (error instanceof ConsoleChargeError) return responderRecusa(res, error);
        throw error;
      }

      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.CHARGE_SETTLED,
        detail: {
          chargeId: resultado.cobranca.id,
          periodEnd: BillingCharge.periodEndOf(resultado.cobranca),
          amountCents: amount,
          expectedCents: Number(resultado.cobranca.amount_cents),
          currency: resultado.cobranca.currency,
          paidAt,
          note,
          reference: resultado.externalId,
          atGateway: resultado.gateway,
          duplicate: resultado.duplicate,
          ...(resultado.alreadyReceivedAtGateway ? { alreadyReceivedAtGateway: true } : {}),
          ...(resultado.acceptedUnderpayment ? { acceptedRecordedUnderpayment: true } : {}),
          ...(force ? { forced: true } : {}),
          ...(amount < Number(resultado.cobranca.amount_cents) ? { underpaymentAccepted: true } : {})
        }
      });
      return res.json(createResponse('Charge settled', {
        charge: await chargeView(tenant.id, resultado.charge),
        subscription: SubscriptionService.present(resultado.state, { withExemptReason: true }),
        duplicate: resultado.duplicate,
        acceptedUnderpayment: resultado.acceptedUnderpayment
      }));
    } catch (error) {
      console.error('Settle charge error:', error);
      return res.status(500).json(createErrorResponse('Failed to settle the charge', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/charges/:chargeId/cancel` — a cobrança
   * sai de cena, no gateway e aqui.
   *
   * O gateway primeiro, e a recusa dele para tudo: cancelada só do lado de cá,
   * ela continuaria na mão do provedor com link de pagamento — e um pagamento
   * dela chegaria para creditar um período que o console decidiu não cobrar.
   * O 404 do gateway já é sucesso em `cancelCharge` (quem apagou lá fez o que
   * se queria).
   *
   * Cancelada, a cobrança do período atual não volta sozinha: a emissão
   * automática trata `canceled` como resolvido. Quem quiser cobrá-la de novo
   * usa o `reissue`.
   */
  static async cancel(req, res) {
    try {
      const chargeId = parseId(req.params?.chargeId);
      if (!chargeId) return res.status(400).json(createErrorResponse('Invalid charge id'));
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 255) : null;
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;

      let resultado;
      try {
        resultado = await runInTenant(tenant.id, async () => {
          const cobranca = await cobrancaEmAberto(chargeId);
          await tomar(cobranca);
          try {
            const gateway = gatewayDa(cobranca, 'cancelCharge');
            if (gateway) await noGateway(() => gateway.cancelCharge(cobranca.gateway_charge_id));
            await BillingCharge.update(cobranca.id, { status: 'canceled', issuing_until: null });
            return { cobranca, gateway: Boolean(gateway), charge: await BillingCharge.findById(cobranca.id) };
          } finally {
            await BillingCharge.release(cobranca.id);
          }
        });
      } catch (error) {
        if (error instanceof ConsoleChargeError) return responderRecusa(res, error);
        throw error;
      }

      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.CHARGE_CANCELED,
        detail: {
          chargeId: resultado.cobranca.id,
          periodEnd: BillingCharge.periodEndOf(resultado.cobranca),
          amountCents: Number(resultado.cobranca.amount_cents),
          statusBefore: resultado.cobranca.status,
          atGateway: resultado.gateway,
          reason
        }
      });
      return res.json(createResponse('Charge canceled', {
        charge: BillingCharge.presentForConsole(resultado.charge)
      }));
    } catch (error) {
      console.error('Cancel charge error:', error);
      return res.status(500).json(createErrorResponse('Failed to cancel the charge', error.message));
    }
  }

  /**
   * `PATCH /api/platform/tenants/:id/charges/:chargeId` — outro vencimento,
   * outro valor, ou os dois.
   *
   * O gateway primeiro, pela mesma razão do cancelamento; a linha depois, com
   * o valor novo — e é a linha que a conferência do pagamento lê
   * (`valorPedido`), então quem pagar o valor novo paga o que se pediu.
   *
   * Uma cobrança que NUNCA chegou ao gateway, de um gateway que emite, é
   * recusada (`not_issued`): a próxima emissão dela reescreve o valor com o
   * preço do plano e o vencimento com o do período (ver `issueCurrent`), e a
   * mudança feita aqui sumiria sem aviso. O gesto certo para ela é o
   * `reissue`.
   *
   * Uma `overdue` com vencimento novo volta a `pending`: ela não está mais
   * atrasada, e é o que o gateway também faz com ela.
   */
  static async update(req, res) {
    try {
      const chargeId = parseId(req.params?.chargeId);
      if (!chargeId) return res.status(400).json(createErrorResponse('Invalid charge id'));
      const body = req.body ?? {};
      const now = new Date();
      let dueDate;
      let amount;
      if (body.dueDate !== undefined) {
        dueDate = parseIsoDay(body.dueDate);
        if (!dueDate) return res.status(400).json(createErrorResponse('dueDate must be a date as YYYY-MM-DD'));
        // Hoje vale; ontem não. O gateway recusa vencimento no passado, e uma
        // cobrança que nasce vencida só serve para gerar aviso de atraso.
        if (dueDate < hoje(now)) return res.status(400).json(createErrorResponse('dueDate cannot be in the past'));
      }
      if (body.amountCents !== undefined) {
        amount = Number(body.amountCents);
        if (!Number.isInteger(amount) || amount <= 0) {
          return res.status(400).json(createErrorResponse('amountCents must be a positive integer'));
        }
      }
      if (dueDate === undefined && amount === undefined) {
        return res.status(400).json(createErrorResponse('Nothing to update'));
      }
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;

      let resultado;
      try {
        resultado = await runInTenant(tenant.id, async () => {
          const cobranca = await cobrancaEmAberto(chargeId);
          if (!cobranca.gateway_charge_id && providerFor(cobranca.provider)?.canIssue) {
            throw new ConsoleChargeError(
              409, 'This charge was never issued at the gateway; reissue it instead', 'not_issued'
            );
          }
          const antes = { amountCents: Number(cobranca.amount_cents), dueDate: isoDateOf(cobranca.due_date) };
          const mudaValor = amount !== undefined && amount !== antes.amountCents;
          const mudaData = dueDate !== undefined && dueDate !== antes.dueDate;
          if (!mudaValor && !mudaData) {
            return { cobranca, antes, depois: antes, charge: cobranca, gateway: false, nada: true };
          }

          await tomar(cobranca, now);
          try {
            const gateway = gatewayDa(cobranca, 'updateCharge');
            let respondido = null;
            if (gateway) {
              respondido = await noGateway(() => gateway.updateCharge(cobranca.gateway_charge_id, {
                ...(mudaData ? { dueDate } : {}),
                ...(mudaValor ? { value: amount } : {}),
                // O valor que ela fica tendo: é sobre ele que o desconto vai.
                amountCents: mudaValor ? amount : antes.amountCents,
                // O meio com que ela nasceu (0100): a de cartão continua de cartão.
                ...(cobranca.billing_type ? { billingType: cobranca.billing_type } : {})
              }));
            }
            const patch = { issuing_until: null };
            // Os termos do desconto que foram com a atualização (0100): é por
            // eles que o pagamento desta cobrança é conferido.
            if (respondido?.discountTerms !== undefined && respondido?.discountTerms !== null) {
              patch.discount_terms = BillingCharge.serializeDiscountTerms(respondido.discountTerms);
            }
            // Marcada (0078): daqui em diante o valor desta linha não é o preço
            // de plano nenhum, e a emissão não o reprecifica.
            if (mudaValor) {
              patch.amount_cents = amount;
              patch.amount_overridden_at = now;
            }
            if (mudaData) {
              // O que o gateway aceitou, quando ele diz: é a data em que o
              // boleto de fato vence, se ele a tiver ajustado.
              patch.due_date = respondido?.dueDate || dueDate;
              if (cobranca.status === 'overdue') patch.status = 'pending';
            }
            await BillingCharge.update(cobranca.id, patch);
            // O valor digitado pelo console é o final (0106): o crédito que
            // estava reservado nela volta ao saldo do provedor, para a
            // próxima fatura.
            if (mudaValor) await TenantCredit.releaseForCharge(cobranca.id);
            const charge = await BillingCharge.findById(cobranca.id);
            return {
              cobranca,
              antes,
              depois: { amountCents: Number(charge.amount_cents), dueDate: isoDateOf(charge.due_date) },
              charge,
              gateway: Boolean(gateway)
            };
          } finally {
            await BillingCharge.release(cobranca.id);
          }
        });
      } catch (error) {
        if (error instanceof ConsoleChargeError) return responderRecusa(res, error);
        throw error;
      }

      if (!resultado.nada) {
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.CHARGE_UPDATED,
          detail: {
            chargeId: resultado.cobranca.id,
            periodEnd: BillingCharge.periodEndOf(resultado.cobranca),
            before: resultado.antes,
            after: resultado.depois,
            atGateway: resultado.gateway
          }
        });
      }
      return res.json(createResponse(resultado.nada ? 'Nothing changed' : 'Charge updated', {
        charge: BillingCharge.presentForConsole(resultado.charge)
      }));
    } catch (error) {
      console.error('Update charge error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the charge', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/charges/:chargeId/refund` — o dinheiro de
   * uma cobrança PAGA volta, e o período que ele comprou é desfeito.
   *
   * Só o estorno inteiro (decisão de quem opera o SaaS): o parcial desfaria um
   * pedaço de período, e ninguém saberia dizer qual.
   *
   * ## A ordem, que é a da baixa ao contrário
   *
   *   1. **A garra**, só sobre linha que AINDA está `paid` (`statuses` na
   *      própria condição do `UPDATE`): entre a leitura e a garra, o
   *      `PAYMENT_REFUNDED` do gateway pode tê-la estornado.
   *   2. **O gateway**, a menos que a cobrança nunca tenha chegado lá (sem id,
   *      ou o provider `manual`) ou que venha `outsideGateway: true` — o
   *      dinheiro vai voltar por fora, e o console só desfaz o lado de cá.
   *      Primeiro a LEITURA (`getCharge`), e ela escolhe o gesto:
   *        - `RECEIVED_IN_CASH` (a baixa manual que o console deu lá dentro):
   *          não há dinheiro do lado de lá, e o que se desfaz é a etiqueta —
   *          `undoReceivedInCash` — e, NO MESMO PASSO, a cobrança é cancelada
   *          lá (`cancelCharge`, 404 é sucesso). Desfeita a baixa, a Asaas a
   *          devolve a `PENDING`, com o link de pagamento valendo; um
   *          pagamento de verdade nela chegaria com o id que o extrato já
   *          conhece, cairia como `duplicate` e o dinheiro entraria sem crédito
   *          nenhum. Se o cancelamento falha, 502 e nada é gravado aqui;
   *        - `RECEIVED`/`CONFIRMED`: o dinheiro entrou pelo gateway e volta
   *          por ele — `refundCharge`;
   *        - já estornada (`REFUNDED`) ou com o estorno a caminho
   *          (`ESTORNO_A_CAMINHO`): alguém estornou no painel da Asaas, ou uma
   *          tentativa anterior deste botão caiu depois do gateway. Segue sem
   *          chamada nenhuma;
   *        - qualquer outro estado: o gateway não tem o dinheiro que o painel
   *          diz ter recebido. 409 `not_paid` com os dois estados — quem sabe
   *          que o dinheiro veio por fora manda de novo com `outsideGateway`.
   *      Qualquer recusa: 502 `gateway_failed`, e NADA é gravado.
   *   3. **O período**, por `SubscriptionService.reversePayment` — pela mesma
   *      referência com que o pagamento foi registrado: o id no gateway, ou
   *      `charge:<id>` da baixa sem gateway (ver `settle`). É a mesma trava
   *      de idempotência do pagamento, e é ela que faz o `PAYMENT_REFUNDED`
   *      que a Asaas manda depois cair como no-op — ou, ao contrário, faz
   *      este botão responder `alreadyRefunded` quando o webhook chegou antes.
   *   4. **A linha vira `refunded`**, e a garra sai.
   *
   * A cobrança estornada NÃO é reemitida sozinha: a emissão trata `refunded`
   * como período resolvido. Se o provedor ainda deve aquele período, é o
   * vencimento (`effectiveStatus`) que o diz, e cobrá-lo de novo é gesto de
   * gente.
   */
  static async refund(req, res) {
    try {
      const chargeId = parseId(req.params?.chargeId);
      if (!chargeId) return res.status(400).json(createErrorResponse('Invalid charge id'));
      const body = req.body ?? {};
      const reason = body.reason ? String(body.reason).slice(0, 255) : null;
      const outsideGateway = body.outsideGateway === true;
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const actorUserId = req.user?.userId ?? null;
      const now = new Date();

      let resultado;
      try {
        resultado = await runInTenant(tenant.id, async () => {
          const cobranca = await BillingCharge.findById(chargeId);
          if (!cobranca) throw new ConsoleChargeError(404, 'Charge not found', 'not_found');
          const naoPaga = (status) => new ConsoleChargeError(
            409, `The charge is ${status}, not paid`, 'not_paid', { status }
          );
          if (cobranca.status !== 'paid') throw naoPaga(cobranca.status);

          const minha = await BillingCharge.claim(cobranca.id, {
            until: new Date(now.getTime() + CLAIM_MS), now, unissued: false, statuses: ['paid']
          });
          if (!minha) {
            const agora = await BillingCharge.findById(cobranca.id);
            if (agora && agora.status !== 'paid') throw naoPaga(agora.status);
            throw new ConsoleChargeError(409, 'The charge is being changed by another process; try again shortly', 'busy');
          }

          try {
            let atGateway = 'skipped';
            const gateway = outsideGateway ? null : gatewayDa(cobranca, 'refundCharge');
            if (gateway) {
              const id = cobranca.gateway_charge_id;
              const situacao = typeof gateway.getCharge === 'function'
                ? await noGateway(() => gateway.getCharge(id))
                : { status: 'RECEIVED' };
              const status = String(situacao?.status ?? '').toUpperCase();
              if (ESTORNADA_NO_GATEWAY.has(status)) {
                atGateway = 'already_refunded';
              } else if (ESTORNO_A_CAMINHO.has(status)) {
                atGateway = 'refund_in_progress';
              } else if (status === 'RECEIVED_IN_CASH' && typeof gateway.undoReceivedInCash === 'function') {
                await noGateway(() => gateway.undoReceivedInCash(id));
                // Sem isto a cobrança volta a ser pagável lá — ver o topo.
                if (typeof gateway.cancelCharge === 'function') {
                  await noGateway(() => gateway.cancelCharge(id));
                }
                atGateway = 'undo_received_in_cash';
              } else if (status === 'RECEIVED' || status === 'CONFIRMED') {
                await noGateway(() => gateway.refundCharge(id));
                atGateway = 'refunded';
              } else {
                throw new ConsoleChargeError(
                  409,
                  `The payment gateway has this charge as ${status || 'unknown'}, not paid; `
                  + 'refund it outside the gateway if the money came another way',
                  'not_paid',
                  { status: cobranca.status, gatewayStatus: status || null }
                );
              }
            }

            // As referências com que ESTA cobrança pode ter sido creditada, na
            // ordem de `settle`: o id no gateway, e a da baixa sem gateway. A
            // primeira que o extrato conhece é a que se desfaz.
            const referencias = [cobranca.gateway_charge_id, `charge:${cobranca.id}`].filter(Boolean);
            let estorno = null;
            for (const referencia of referencias) {
              estorno = await SubscriptionService.reversePayment({
                externalId: referencia, reason, actorUserId, source: 'console'
              });
              if (estorno.found) {
                estorno.reference = referencia;
                break;
              }
            }
            if (!estorno.found) {
              // Paga sem pagamento no extrato: uma linha mexida à mão, ou paga
              // por um id que a troca de plano substituiu. O dinheiro volta
              // igual, mas não há período conhecido a desfazer — dito em voz
              // alta, e o prazo fica como está.
              console.warn(
                `Console refund of charge ${cobranca.id} (provider ${tenant.id}): no recorded payment `
                + `under ${referencias.join(' or ')}; the subscription period was not changed`
              );
            }

            await BillingCharge.update(cobranca.id, { status: 'refunded', issuing_until: null });
            // A NFS-e do dinheiro que voltou, cancelada. Nunca lança: a falha
            // fica no log e na linha da nota, e o estorno segue.
            const nota = await BillingInvoiceService.cancelForCharge(cobranca.id);
            return {
              cobranca, estorno, atGateway, invoiceCancel: nota, charge: await BillingCharge.findById(cobranca.id)
            };
          } finally {
            await BillingCharge.release(cobranca.id);
          }
        });
      } catch (error) {
        if (error instanceof ConsoleChargeError) return responderRecusa(res, error);
        throw error;
      }

      const { estorno } = resultado;
      // O `duplicate` de quem acabou de mover o dinheiro é o webhook do
      // próprio gesto chegando antes — não um estorno anterior. As datas vêm
      // do registro que ganhou a corrida (ver `reversePayment`), e são as
      // mesmas que este gesto teria gravado.
      const alreadyRefunded = Boolean(estorno.duplicate) && !GESTOS_QUE_MOVEM.has(resultado.atGateway);
      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.CHARGE_REFUNDED,
        detail: {
          chargeId: resultado.cobranca.id,
          periodEnd: BillingCharge.periodEndOf(resultado.cobranca),
          amountCents: Number(resultado.cobranca.amount_cents),
          currency: resultado.cobranca.currency,
          renewsAtBefore: estorno.renewsAtBefore,
          renewsAtAfter: estorno.renewsAtAfter,
          outsideGateway,
          atGateway: resultado.atGateway,
          reference: estorno.reference ?? null,
          alreadyRefunded,
          reason,
          ...(resultado.invoiceCancel?.reason !== 'no_invoice'
            ? { invoiceCanceled: Boolean(resultado.invoiceCancel?.canceled) }
            : {})
        }
      });
      return res.json(createResponse('Charge refunded', {
        charge: await chargeView(tenant.id, resultado.charge),
        subscription: await subscriptionView(tenant),
        renewsAtBefore: estorno.renewsAtBefore,
        renewsAtAfter: estorno.renewsAtAfter,
        alreadyRefunded
      }));
    } catch (error) {
      console.error('Refund charge error:', error);
      return res.status(500).json(createErrorResponse('Failed to refund the charge', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/charges/:chargeId/reissue` — cobrar de
   * novo o período atual, pela porta de sempre.
   *
   * Só a cobrança `canceled` ou `failed` do período ATUAL (a chave do prazo
   * vivo, calculada como a emissão a calcula). Uma de período passado não tem
   * o que reemitir: o período dela acabou, e cobrá-lo de novo é uma cobrança
   * avulsa, não uma reemissão.
   *
   * Quem emite é `ChargeIssuingService.issueCurrent({ manual: true })` — o
   * mesmo caminho do "pagar agora" do provedor —, que já reabre a cancelada
   * do período com o preço de agora (guardando o id velho em
   * `superseded_charges`) e zera as tentativas da que falhou. Uma segunda
   * implementação aqui seria a que esquece a garra ou o preço da descida
   * agendada.
   */
  static async reissue(req, res) {
    try {
      const chargeId = parseId(req.params?.chargeId);
      if (!chargeId) return res.status(400).json(createErrorResponse('Invalid charge id'));
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;

      let resultado;
      try {
        resultado = await runInTenant(tenant.id, async () => {
          const cobranca = await BillingCharge.findById(chargeId);
          if (!cobranca) throw new ConsoleChargeError(404, 'Charge not found', 'not_found');
          if (cobranca.status !== 'canceled' && cobranca.status !== 'failed') {
            throw new ConsoleChargeError(409, `A ${cobranca.status} charge cannot be reissued`, 'not_reissuable', {
              status: cobranca.status
            });
          }
          // A fatura de pró-rata (0101) não é do período: a reemissão dela é a
          // retentativa da que FALHOU no gateway, pela porta do agendador
          // (`retryProrations`), com a mesma referência. A cancelada fica
          // cancelada — cobrar de novo a diferença é uma decisão nova.
          if (isProration(cobranca)) {
            if (cobranca.status !== 'failed' || cobranca.gateway_charge_id) {
              throw new ConsoleChargeError(409, `A ${cobranca.status} proration charge cannot be reissued`, 'not_reissuable', {
                status: cobranca.status
              });
            }
            const retentativa = await ChargeIssuingService.retryProrations({ tenant, manual: true, chargeId: cobranca.id });
            const emissao = retentativa.result;
            if (!emissao) {
              const motivo = retentativa.reason ?? 'busy';
              throw new ConsoleChargeError(409, `The charge was not reissued: ${motivo}`, motivo);
            }
            if (emissao.reason === 'gateway_failed') {
              throw new ConsoleChargeError(502, `The payment gateway refused: ${emissao.error}`, 'gateway_failed', {
                detail: emissao.error
              });
            }
            if (!emissao.issued && emissao.reason !== 'already_issued') {
              throw new ConsoleChargeError(409, `The charge was not reissued: ${emissao.reason}`, emissao.reason);
            }
            return {
              cobranca,
              issued: emissao.issued,
              charge: emissao.charge ?? await BillingCharge.findById(cobranca.id)
            };
          }
          const assinatura = await Subscription.forTenant(tenant.id);
          // O mesmo prazo que `issueCurrent` lê, na mesma ordem.
          const prazo = assinatura?.renews_at ?? assinatura?.trial_ends_at ?? null;
          const vencimento = prazo ? new Date(prazo) : null;
          if (!vencimento || Number.isNaN(vencimento.getTime())) {
            throw new ConsoleChargeError(409, 'The subscription has no current period', 'no_deadline');
          }
          if (String(cobranca.period_end).slice(0, 10) !== ChargeIssuingService.periodKey(vencimento)) {
            throw new ConsoleChargeError(
              409, 'Only a charge of the current period can be reissued', 'not_current_period'
            );
          }

          const emissao = await ChargeIssuingService.issueCurrent({ manual: true, tenant });
          if (emissao.reason === 'gateway_failed') {
            throw new ConsoleChargeError(502, `The payment gateway refused: ${emissao.error}`, 'gateway_failed', {
              detail: emissao.error
            });
          }
          // `already_issued` é sucesso: a cobrança do período está viva no
          // gateway, emitida por outra passada no meio — que é o que se pediu.
          // `card_deferred` também: a assinatura tem cartão salvo, e a linha
          // reaberta sai no cartão no dia do vencimento, pelo agendador — o
          // console não cobra o cartão antes da hora.
          if (!emissao.issued && emissao.reason !== 'already_issued' && emissao.reason !== 'card_deferred') {
            throw new ConsoleChargeError(409, `The charge was not reissued: ${emissao.reason}`, emissao.reason);
          }
          return {
            cobranca,
            issued: emissao.issued,
            charge: emissao.charge ?? await BillingCharge.findById(cobranca.id)
          };
        });
      } catch (error) {
        if (error instanceof ConsoleChargeError) return responderRecusa(res, error);
        throw error;
      }

      if (resultado.issued) {
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.CHARGE_REISSUED,
          detail: {
            chargeId: resultado.cobranca.id,
            periodEnd: BillingCharge.periodEndOf(resultado.cobranca),
            statusBefore: resultado.cobranca.status,
            amountCents: Number(resultado.charge?.amount_cents ?? 0)
          }
        });
      }
      return res.json(createResponse('Charge reissued', {
        charge: BillingCharge.presentForConsole(resultado.charge)
      }));
    } catch (error) {
      console.error('Reissue charge error:', error);
      return res.status(500).json(createErrorResponse('Failed to reissue the charge', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/charges/:chargeId/invoice` — emitir a
   * NFS-e de uma cobrança paga, ou emitir de novo a que deu erro ou foi
   * cancelada.
   *
   * Só põe na fila (202): quem fala com a Asaas é o agendador, na próxima
   * passada, com a mesma garra e as mesmas tentativas da emissão automática.
   * Uma segunda porta que chamasse a Asaas daqui seria a que pede a segunda
   * nota do mesmo pagamento numa corrida com ele.
   *
   * 409: `not_paid`, `no_gateway_payment` (baixa sem gateway), `nfse_disabled`,
   * `invoice_exists` (com `invoiceStatus`) e `busy`. 404 `not_found`.
   */
  static async issueInvoice(req, res) {
    try {
      const chargeId = parseId(req.params?.chargeId);
      if (!chargeId) return res.status(400).json(createErrorResponse('Invalid charge id'));
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;

      let resultado;
      try {
        resultado = await runInTenant(tenant.id, async () => {
          const cobranca = await BillingCharge.findById(chargeId);
          const pedido = await BillingInvoiceService.requestForCharge(cobranca);
          return { cobranca, ...pedido };
        });
      } catch (error) {
        if (error instanceof InvoiceRequestError) return responderRecusa(res, error);
        throw error;
      }

      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.CHARGE_INVOICE_REQUESTED,
        detail: {
          chargeId: resultado.cobranca.id,
          periodEnd: BillingCharge.periodEndOf(resultado.cobranca),
          amountCents: Number(resultado.cobranca.amount_cents),
          invoiceStatusBefore: resultado.statusBefore
        }
      });
      return res.status(202).json(createResponse('Invoice queued', {
        charge: BillingCharge.presentForConsole(resultado.cobranca, resultado.invoice),
        invoice: BillingInvoice.presentForConsole(resultado.invoice)
      }));
    } catch (error) {
      console.error('Issue invoice error:', error);
      return res.status(500).json(createErrorResponse('Failed to queue the invoice', error.message));
    }
  }
}

export { responderFollow };
export default PlatformSubscriptionsController;

import { getDb } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';
import BillingCharge, { OPEN_CHARGE_STATUSES, isoDateOf } from '../models/BillingCharge.js';
import { BILLING_EVENT_TYPES } from '../models/BillingEvent.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import Tenant from '../models/Tenant.js';
import SubscriptionService from './subscriptionService.js';
import { toCsvWith } from '../utils/csv.js';

/**
 * O relatório de receita do console: quanto a plataforma fatura por mês
 * (MRR), quanto entrou e voltou num período, quanto está para receber, e de
 * que plano vem.
 *
 * Só leitura, e acima dos provedores: as consultas são `runUnscoped` com o
 * marcador, como `Subscription.listWithPlans` e
 * `BillingCharge.openAcrossTenants` — quem pergunta é o console, e a pergunta
 * é sobre todos.
 *
 * ## Por que somar em JS
 *
 * Agrupar por mês em SQL é `strftime` no SQLite, `date_trunc` no Postgres e
 * `DATE_FORMAT` no MySQL — três dialetos para a mesma pergunta, e o SQLite
 * ainda guarda o mesmo timestamp em dois formatos (texto do `fn.now()` e
 * milissegundos de um `Date` do knex). O volume é pequeno — uma cobrança por
 * provedor por período —, então lê-se a linha crua e o mês sai daqui, de um
 * jeito só para os três bancos.
 *
 * ## O dinheiro vem do extrato, não das cobranças
 *
 * Recebido e estornado são somados dos EVENTOS (`billing_events`): cada
 * `payment.recorded` pelo seu `amount_cents` e pelo seu `created_at`, cada
 * `payment.refunded` idem. É o extrato que sabe de todo dinheiro — a baixa
 * manual do console sem cobrança nenhuma, o pagamento de uma cobrança criada
 * à mão no gateway e que nunca teve linha aqui, o pagamento a menos (que
 * entra pelo que veio, e não pelo que se pediu). Não há dupla contagem: cada
 * pagamento é UM evento (a idempotência por referência de `recordPayment`), o
 * aceite da diferença (`<ref>:accepted`) é gravado com zero e não conta como
 * pagamento, e o estorno é um evento só (`<ref>:refund`) com o valor do
 * pagamento que desfez. As cobranças continuam respondendo o que só elas
 * sabem: o em aberto, o vencido e as linhas da planilha.
 *
 * ## Quando uma cobrança "aconteceu" (a planilha)
 *
 * `billing_charges` não tem `paid_at`. O instante do pagamento é o do evento
 * `payment.recorded` do extrato com a referência da cobrança — o id no
 * gateway, a baixa sem gateway (`charge:<id>`) ou um id que a troca de plano
 * substituiu —, e o do estorno é o `payment.refunded` com `<referência>:refund`.
 * Sem evento (uma linha mexida à mão), vale o `updated_at` da linha, que é a
 * última vez que alguém a tocou. Na planilha, em aberto e cancelada entram
 * pelo vencimento (ou pela criação, sem vencimento); nos totais, o em aberto é
 * o de agora, de qualquer período.
 *
 * Os meses são em UTC, como as datas `from`/`to`: o relatório é da plataforma,
 * não de um fuso de provedor.
 */

/** O teto do período, em meses. Mais que isso é exportar o banco, não um relatório. */
export const MAX_RANGE_MONTHS = 36;

/** O período padrão: os últimos doze meses, contando o atual. */
export const DEFAULT_RANGE_MONTHS = 12;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Uma recusa do período, com o código que a tela traduz. */
export class RevenueRangeError extends Error {
  constructor(message, code) {
    super(message);
    this.status = 400;
    this.code = code;
  }
}

/** `YYYY-MM-DD` de um instante, em UTC. */
const diaUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

/** `YYYY-MM` de um instante, em UTC. */
const mesUtc = (ms) => new Date(ms).toISOString().slice(0, 7);

/** Um `YYYY-MM-DD` que existe no calendário, como meia-noite UTC — ou nulo. */
function diaValido(texto) {
  const partes = ISO_DIA.exec(String(texto ?? '').trim());
  if (!partes) return null;
  const [, ano, mes, dia] = partes.map(Number);
  const ms = Date.UTC(ano, mes - 1, dia);
  // `Date.UTC(2026, 1, 31)` vira 3 de março; uma data que não volta igual
  // não existe.
  return diaUtc(ms) === `${partes[1]}-${partes[2]}-${partes[3]}` ? ms : null;
}

/** Os meses `YYYY-MM` de `inicio` a `fim`, inclusive, em ordem. */
function mesesEntre(inicioMs, fimMs) {
  const meses = [];
  const inicio = new Date(inicioMs);
  let ano = inicio.getUTCFullYear();
  let mes = inicio.getUTCMonth();
  const ultimo = mesUtc(fimMs);
  for (;;) {
    const chave = `${ano}-${String(mes + 1).padStart(2, '0')}`;
    meses.push(chave);
    if (chave >= ultimo) break;
    mes += 1;
    if (mes > 11) { mes = 0; ano += 1; }
  }
  return meses;
}

/**
 * O período pedido, validado.
 *
 * Sem `from`/`to`, os últimos doze meses: do primeiro dia do mês de onze meses
 * atrás até hoje. Um só dos dois vale com o outro no padrão. Recusa (400) data
 * que não existe, `from` depois de `to` e período maior que trinta e seis
 * meses — contados como meses de calendário tocados, que é o número de barras
 * que o gráfico desenharia.
 *
 * @returns {{ from: string, to: string, startMs: number, endMs: number, months: string[] }}
 *   `endMs` é exclusivo: a meia-noite do dia seguinte a `to`.
 */
export function parseRange(query = {}, now = new Date()) {
  const temFrom = query.from !== undefined && query.from !== null && String(query.from).trim() !== '';
  const temTo = query.to !== undefined && query.to !== null && String(query.to).trim() !== '';
  let fimMs;
  if (temTo) {
    fimMs = diaValido(query.to);
    if (fimMs === null) throw new RevenueRangeError('`to` must be a valid YYYY-MM-DD date', 'invalid_date');
  } else {
    fimMs = diaValido(diaUtc(now.getTime()));
  }
  let inicioMs;
  if (temFrom) {
    inicioMs = diaValido(query.from);
    if (inicioMs === null) throw new RevenueRangeError('`from` must be a valid YYYY-MM-DD date', 'invalid_date');
  } else {
    const fim = new Date(fimMs);
    inicioMs = Date.UTC(fim.getUTCFullYear(), fim.getUTCMonth() - (DEFAULT_RANGE_MONTHS - 1), 1);
  }
  if (inicioMs > fimMs) throw new RevenueRangeError('`from` must not be after `to`', 'invalid_range');
  const months = mesesEntre(inicioMs, fimMs);
  if (months.length > MAX_RANGE_MONTHS) {
    throw new RevenueRangeError(`The period may span at most ${MAX_RANGE_MONTHS} months`, 'range_too_long');
  }
  return { from: diaUtc(inicioMs), to: diaUtc(fimMs), startMs: inicioMs, endMs: fimMs + DAY_MS, months };
}

/**
 * Um instante do banco, como milissegundos — ou nulo.
 *
 * O texto sem fuso (`2026-03-01 12:00:00`, o `CURRENT_TIMESTAMP` do SQLite) é
 * UTC; lido por `new Date` puro, viraria hora local do processo.
 */
export function instanteMs(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.getTime();
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  let texto = String(valor).trim();
  if (/^\d+$/.test(texto)) return Number(texto);
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) texto = `${texto}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(texto)) texto = `${texto.replace(' ', 'T')}Z`;
  const ms = new Date(texto).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * O preço que a assinatura de fato paga por período.
 *
 * Com cupom (`SubscriptionService.effectivePriceCents`, quando existir), o
 * preço com desconto; sem, o do plano. A pergunta é feita em tempo de
 * execução porque o cupom chega em outra frente — e um relatório que quebra
 * porque o cupom não existe, ou que ignora o cupom quando ele existe, mente do
 * mesmo jeito. Uma falha do cálculo cai no preço do plano em vez de derrubar o
 * relatório inteiro.
 */
export async function precoEfetivo(sub, plan) {
  // O preço do ciclo da assinatura (0104): o anual cobra o ano.
  const doPlano = SubscriptionService.cyclePriceCents(sub, plan);
  if (typeof SubscriptionService.effectivePriceCents === 'function') {
    try {
      const preco = Number(await SubscriptionService.effectivePriceCents(sub, plan));
      if (Number.isFinite(preco) && preco >= 0) return Math.round(preco);
    } catch (error) {
      console.warn(`Revenue report: effective price of subscription ${sub?.id} failed, using the plan price: ${error.message}`);
    }
  }
  return doPlano;
}

/** As referências com que o extrato pode ter creditado esta cobrança. */
function referenciasDe(charge) {
  const refs = [];
  if (charge.gateway_charge_id) refs.push(String(charge.gateway_charge_id));
  refs.push(`charge:${charge.id}`);
  for (const antiga of BillingCharge.supersededOf(charge)) refs.push(String(antiga.id));
  return refs;
}

/** O primeiro instante, entre as referências, de um evento do índice — ou nulo. */
function primeiroEvento(indice, tenantId, refs, sufixo = '') {
  let menor = null;
  for (const ref of refs) {
    const ms = indice.get(`${tenantId}|${ref}${sufixo}`);
    if (ms !== undefined && ms !== null && (menor === null || ms < menor)) menor = ms;
  }
  return menor;
}

/**
 * Os instantes de uma cobrança: quando foi paga, quando foi estornada, e a
 * data que a põe (ou não) no período.
 */
export function datasDaCobranca(charge, { pagamentos, estornos }) {
  const tenantId = Number(charge.tenant_id);
  const refs = referenciasDe(charge);
  const tocada = instanteMs(charge.updated_at) ?? instanteMs(charge.created_at);
  let paidAtMs = null;
  let refundedAtMs = null;
  if (charge.status === 'paid' || charge.status === 'refunded') {
    paidAtMs = primeiroEvento(pagamentos, tenantId, refs) ?? tocada;
  }
  if (charge.status === 'refunded') {
    refundedAtMs = primeiroEvento(estornos, tenantId, refs, ':refund') ?? tocada;
  }
  const vencimento = isoDateOf(charge.due_date);
  const dueMs = vencimento ? instanteMs(vencimento) : null;
  const referenciaMs = paidAtMs ?? dueMs ?? instanteMs(charge.created_at);
  return { paidAtMs, refundedAtMs, dueMs, dueDate: vencimento, referenciaMs };
}

/** Indexa os eventos de pagamento e estorno por `tenant|referência`, com o mais antigo. */
export function indexarEventos(eventos) {
  const pagamentos = new Map();
  const estornos = new Map();
  for (const evento of eventos) {
    if (!evento.external_id) continue;
    const alvo = evento.type === BILLING_EVENT_TYPES.PAYMENT_REFUNDED ? estornos
      : evento.type === BILLING_EVENT_TYPES.PAYMENT_RECORDED ? pagamentos : null;
    if (!alvo) continue;
    const chave = `${Number(evento.tenant_id)}|${evento.external_id}`;
    const ms = instanteMs(evento.created_at);
    if (ms === null) continue;
    const atual = alvo.get(chave);
    if (atual === undefined || ms < atual) alvo.set(chave, ms);
  }
  return { pagamentos, estornos };
}

/** O `detail` de um evento, lido — ou nulo. */
function detalheDe(evento) {
  const bruto = evento?.detail;
  if (!bruto) return null;
  if (typeof bruto === 'object') return bruto;
  try {
    const lido = JSON.parse(bruto);
    return lido && typeof lido === 'object' ? lido : null;
  } catch {
    return null;
  }
}

/** Os dias de um período da assinatura no plano — 365 no anual (0104). */
function diasDoPeriodo(sub, plan) {
  return SubscriptionService.cyclePeriodDays(sub, plan);
}

/**
 * A soma, sem banco: o que o relatório responde, a partir das linhas cruas.
 *
 * Pura de propósito — é aqui que mora cada decisão do relatório, e é aqui que
 * os testes as fixam sem montar provedor nenhum.
 *
 * - **MRR**: só assinatura cujo estado que VALE é `active`, sem isenção de
 *   cobrança e com preço efetivo acima de zero — trial não paga ainda,
 *   `past_due` já não está pagando, isento e plano grátis não pagam nunca. O
 *   preço do período vira mensal por `× 30 / dias do ciclo` (365 no anual).
 * - **Recebido**: os pagamentos do extrato com o evento no período, pelo valor
 *   que entrou; por plano, o plano que o pagamento pagou (`detail.planId`)
 *   ou, sem ele, o de agora. **Estornado**: os estornos do extrato no
 *   período. Recebido não desconta estorno: são dois números, e o líquido é a
 *   diferença.
 * - **Em aberto**: TODAS as em aberto agora (`pending`, `failed`,
 *   `overdue`), de qualquer período, incluindo as vencidas; **vencido** é a parte delas
 *   que o gateway chamou de `overdue` ou que passou do vencimento — a mesma
 *   regra da tela de Assinaturas.
 * - **Desconto** (APROXIMADO, e a tela diz): nos pagamentos do período que
 *   não foram estornados, quanto o preço de HOJE do plano pago passa do valor
 *   que se pediu (`detail.expectedCents` — cupom ou valor mexido à mão). O
 *   preço de tabela da época não é gravado em lugar nenhum; se o plano mudou
 *   de preço, a conta erra pela diferença.
 */
export function aggregateRevenue({
  range, now = new Date(), tenants, subscriptions, plans, prices, charges, events
}) {
  const hoje = diaUtc(now.getTime());
  const provedores = new Set(tenants.map((t) => Number(t.id)));
  const planos = new Map(plans.map((p) => [Number(p.id), p]));
  const assinaturaPorId = new Map();
  const assinaturaPorProvedor = new Map();
  for (const sub of subscriptions) {
    if (!provedores.has(Number(sub.tenant_id))) continue;
    assinaturaPorId.set(Number(sub.id), sub);
    assinaturaPorProvedor.set(Number(sub.tenant_id), sub);
  }

  const porPlano = new Map();
  const linhaDoPlano = (planId) => {
    const chave = planId === null || planId === undefined ? null : Number(planId);
    if (!porPlano.has(chave)) {
      porPlano.set(chave, {
        planId: chave, name: chave === null ? null : (planos.get(chave)?.name ?? null),
        activeCount: 0, mrrCents: 0, receivedCents: 0
      });
    }
    return porPlano.get(chave);
  };

  let mrrCents = 0;
  let activeCount = 0;
  for (const sub of assinaturaPorProvedor.values()) {
    if (SubscriptionService.effectiveStatus(sub, now).status !== 'active') continue;
    if (sub.billing_exempt_at) continue;
    const plano = planos.get(Number(sub.plan_id));
    if (!plano) continue;
    const preco = Number(prices.get(Number(sub.id)) ?? SubscriptionService.cyclePriceCents(sub, plano));
    if (!(preco > 0)) continue;
    // Normalizado para trinta dias: o anual entra como 1/12 (× 30 / 365).
    const mensal = Math.round((preco * 30) / diasDoPeriodo(sub, plano));
    mrrCents += mensal;
    activeCount += 1;
    const linha = linhaDoPlano(plano.id);
    linha.activeCount += 1;
    linha.mrrCents += mensal;
  }

  const mensal = new Map(range.months.map((m) => [m, { month: m, receivedCents: 0, refundedCents: 0, count: 0 }]));
  const dentro = (ms) => ms !== null && ms >= range.startMs && ms < range.endMs;

  let receivedCents = 0;
  let refundedCents = 0;
  let openCents = 0;
  let overdueCents = 0;
  let discountCents = 0;
  const inadimplentes = new Set();

  // Os pagamentos que já voltaram (a qualquer tempo): não dão desconto a ninguém.
  const estornados = new Set();
  for (const evento of events) {
    if (evento.type !== BILLING_EVENT_TYPES.PAYMENT_REFUNDED) continue;
    const ref = detalheDe(evento)?.reference
      ?? (String(evento.external_id ?? '').endsWith(':refund') ? String(evento.external_id).slice(0, -':refund'.length) : null);
    if (ref) estornados.add(`${Number(evento.tenant_id)}|${ref}`);
  }

  for (const evento of events) {
    const tenantId = Number(evento.tenant_id);
    if (!provedores.has(tenantId)) continue;
    const ms = instanteMs(evento.created_at);
    if (!dentro(ms)) continue;
    const valor = Number(evento.amount_cents) || 0;
    const mes = mensal.get(mesUtc(ms));
    if (evento.type === BILLING_EVENT_TYPES.PAYMENT_REFUNDED) {
      refundedCents += valor;
      if (mes) mes.refundedCents += valor;
      continue;
    }
    if (evento.type !== BILLING_EVENT_TYPES.PAYMENT_RECORDED) continue;
    // O aceite da diferença é um evento de valor zero que só destrava o
    // período: não é um segundo pagamento.
    const aceite = String(evento.external_id ?? '').endsWith(':accepted');
    const detalhe = detalheDe(evento);
    const sub = assinaturaPorId.get(Number(evento.subscription_id)) || assinaturaPorProvedor.get(tenantId) || null;
    const planoId = detalhe?.planId ?? sub?.plan_id ?? null;
    const plano = planoId === null || planoId === undefined ? null : planos.get(Number(planoId)) ?? null;
    receivedCents += valor;
    if (mes) {
      mes.receivedCents += valor;
      if (!aceite) mes.count += 1;
    }
    if (valor) linhaDoPlano(plano ? plano.id : null).receivedCents += valor;
    // A pró-rata da subida (0101) entra no recebido como qualquer pagamento,
    // mas não no desconto: o valor pedido nela é uma fração do período, e
    // compará-lo com o preço cheio do plano inventaria um abatimento.
    if (!aceite && !detalhe?.proration && plano && !estornados.has(`${tenantId}|${evento.external_id}`)) {
      // O preço cheio do ciclo que o pagamento pagou (0104): o do ano, se anual.
      const cheio = SubscriptionService.cyclePriceCents({ billing_cycle: detalhe?.billingCycle ?? 'monthly' }, plano);
      // O preço do plano (com o cupom) gravado no pagamento, quando há: o
      // pedido inteiro traz o excedente (que não é preço) e já vem sem o
      // crédito (que não é desconto). Sem ele (os eventos de antes), o pedido.
      const base = detalhe?.baseCents;
      const esperado = base !== null && base !== undefined && Number.isFinite(Number(base)) ? base : detalhe?.expectedCents;
      const pedido = esperado === null || esperado === undefined || !Number.isFinite(Number(esperado))
        ? valor : Number(esperado);
      if (pedido < cheio) discountCents += cheio - pedido;
    }
  }

  for (const charge of charges) {
    const tenantId = Number(charge.tenant_id);
    if (!provedores.has(tenantId)) continue;
    const valor = Number(charge.amount_cents) || 0;
    // Em aberto é fotografia de AGORA, e não do período: a pergunta é "quanto
    // temos a receber", e uma cobrança velha esquecida em aberto é dinheiro a
    // receber como as outras — a mesma conta da tela de Assinaturas.
    if (OPEN_CHARGE_STATUSES.includes(charge.status)) {
      const vencimento = isoDateOf(charge.due_date);
      openCents += valor;
      if (charge.status === 'overdue' || (vencimento && vencimento < hoje)) {
        overdueCents += valor;
        inadimplentes.add(tenantId);
      }
    }
  }

  const byPlan = [...porPlano.values()]
    .filter((linha) => linha.activeCount > 0 || linha.receivedCents > 0)
    .sort((a, b) => (b.mrrCents - a.mrrCents) || (b.receivedCents - a.receivedCents)
      || String(a.name ?? '').localeCompare(String(b.name ?? '')));

  return {
    from: range.from,
    to: range.to,
    mrrCents,
    activeCount,
    receivedCents,
    refundedCents,
    openCents,
    overdueCents,
    overdueTenants: inadimplentes.size,
    monthly: [...mensal.values()],
    byPlan,
    discountCents,
    // O desconto é estimado contra o preço de HOJE do plano (ver acima): a
    // tela o rotula assim.
    discountApproximate: true
  };
}

/** As linhas cruas que o relatório soma, numa leitura só de cada tabela. */
async function carregar() {
  const [tenants, subscriptions, plans] = await Promise.all([
    Tenant.list(), Subscription.listWithPlans(), Plan.list()
  ]);
  // tenant-scope-exempt: relatório do plano de controle, acima dos provedores.
  const charges = await runUnscoped('the console revenue report reads every provider\'s charges', () => getDb()('billing_charges')
    .select(
      'id', 'tenant_id', 'subscription_id', 'amount_cents', 'currency', 'status', 'due_date',
      'gateway_charge_id', 'superseded_charges', 'period_end', 'created_at', 'updated_at'
    )
    .orderBy('id', 'asc'));
  // tenant-scope-exempt: idem — os pagamentos e estornos, que são o dinheiro
  // do relatório e que datam as cobranças da planilha. Com os sem referência:
  // a marca manual do console também é dinheiro que entrou.
  const events = await runUnscoped('the console revenue report reads every provider\'s payments', () => getDb()('billing_events')
    .whereIn('type', [BILLING_EVENT_TYPES.PAYMENT_RECORDED, BILLING_EVENT_TYPES.PAYMENT_REFUNDED])
    .select('tenant_id', 'subscription_id', 'type', 'external_id', 'amount_cents', 'detail', 'created_at'));
  return { tenants, subscriptions, plans, charges, events };
}

/** O relatório do período, pronto para a resposta. */
export async function buildRevenueReport(range, now = new Date()) {
  const dados = await carregar();
  const planos = new Map(dados.plans.map((p) => [Number(p.id), p]));
  const prices = new Map();
  for (const sub of dados.subscriptions) {
    prices.set(Number(sub.id), await precoEfetivo(sub, planos.get(Number(sub.plan_id))));
  }
  return aggregateRevenue({ range, now, prices, ...dados });
}

/** As colunas da planilha de cobranças do período. */
export const REVENUE_CSV_COLUMNS = Object.freeze([
  { header: 'Provedor', field: 'tenant' },
  { header: 'Plano', field: 'plan' },
  { header: 'Valor', field: 'amount' },
  { header: 'Moeda', field: 'currency' },
  { header: 'Status', field: 'status' },
  { header: 'Vencimento', field: 'dueDate' },
  { header: 'Pago em', field: 'paidAt' },
  { header: 'ID no gateway', field: 'gatewayChargeId' },
  { header: 'Estornado em', field: 'refundedAt' }
]);

/** Centavos como o Excel em português lê: vírgula decimal. */
const reais = (centavos) => (Number(centavos || 0) / 100).toFixed(2).replace('.', ',');

/** Um instante como `YYYY-MM-DD HH:MM:SS` em UTC, ou vazio. */
const quando = (ms) => (ms === null ? '' : new Date(ms).toISOString().slice(0, 19).replace('T', ' '));

/**
 * As cobranças do período, como linhas da planilha: as pagas e estornadas pelo
 * pagamento, as outras pelo vencimento — a mesma data que as põe no relatório.
 * As mais antigas primeiro.
 */
export function revenueCsvRows({ range, tenants, subscriptions, plans, charges, events }) {
  const nomes = new Map(tenants.map((t) => [Number(t.id), t.name ?? t.slug ?? String(t.id)]));
  const planos = new Map(plans.map((p) => [Number(p.id), p]));
  const assinaturaPorId = new Map(subscriptions.map((s) => [Number(s.id), s]));
  const assinaturaPorProvedor = new Map(subscriptions.map((s) => [Number(s.tenant_id), s]));
  const indice = indexarEventos(events);
  const linhas = [];
  for (const charge of charges) {
    const tenantId = Number(charge.tenant_id);
    if (!nomes.has(tenantId)) continue;
    const datas = datasDaCobranca(charge, indice);
    if (datas.referenciaMs === null || datas.referenciaMs < range.startMs || datas.referenciaMs >= range.endMs) continue;
    const sub = assinaturaPorId.get(Number(charge.subscription_id)) || assinaturaPorProvedor.get(tenantId) || null;
    const plano = sub ? planos.get(Number(sub.plan_id)) : null;
    linhas.push({
      ordem: datas.referenciaMs,
      id: Number(charge.id),
      tenant: nomes.get(tenantId),
      plan: plano?.name ?? '',
      amount: reais(charge.amount_cents),
      currency: charge.currency || 'BRL',
      status: charge.status,
      dueDate: datas.dueDate ?? '',
      paidAt: quando(datas.paidAtMs),
      gatewayChargeId: charge.gateway_charge_id ?? '',
      refundedAt: quando(datas.refundedAtMs)
    });
  }
  linhas.sort((a, b) => (a.ordem - b.ordem) || (a.id - b.id));
  return linhas;
}

/** A planilha do período, e quantas cobranças ela tem. */
export async function buildRevenueCsv(range) {
  const dados = await carregar();
  const linhas = revenueCsvRows({ range, ...dados });
  return { csv: toCsvWith(REVENUE_CSV_COLUMNS, linhas), count: linhas.length };
}

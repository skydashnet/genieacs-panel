import crypto from 'node:crypto';
import { getDb, tdb, isUniqueViolation } from '../config/database.js';
import { runInTenant } from '../config/tenantContext.js';
import TenantCredit from '../models/TenantCredit.js';
import { referralRewardCents } from './platformProfileService.js';
import { panelBaseDomain, platformExtraHosts } from '../middleware/tenantResolver.js';

/**
 * A indicação de provedores (0106).
 *
 * Um provedor tem um código curto (`tenants.referral_code`, gerado na primeira
 * vez que alguém abre a tela de Plano) e um link `…/signup?ref=CÓDIGO`. Quem se
 * cadastra por esse link nasce com `referred_by_tenant_id` e uma linha
 * `pending` em `referral_rewards`. No primeiro pagamento DELE que estende o
 * período — a pró-rata não estende, e o pago a menos também não —, quem
 * indicou ganha um crédito de `referralRewardCents` (Configurações do
 * console), gravado na MESMA transação do evento do pagamento: a reentrega do
 * webhook morre no índice único do evento e leva junto a recompensa, e a
 * segunda passagem pela linha `pending` não acha mais nada a mudar.
 *
 * O crédito é abatido na próxima fatura de quem indicou (ver
 * `ChargeIssuingService.issueCurrent` e `TenantCredit`). O estorno daquele
 * pagamento cancela o que sobrar dele.
 *
 * `tenants` e `referral_rewards` são compartilhadas: toda leitura aqui nomeia
 * o provedor de que fala. O crédito mora em `tenant_credits` (escopada), e é
 * gravado no escopo de quem indicou.
 */

/** O alfabeto do código: sem 0/O, 1/I/L, que se confundem ao ditar. */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TAMANHO_DO_CODIGO = 8;

/** Um código novo, aleatório. */
export function generateReferralCode() {
  const bytes = crypto.randomBytes(TAMANHO_DO_CODIGO);
  let codigo = '';
  for (const byte of bytes) codigo += ALFABETO[byte % ALFABETO.length];
  return codigo;
}

/** O código como veio do link: maiúsculas, sem o que não é letra nem dígito. */
export function normalizeReferralCode(bruto) {
  const texto = String(bruto ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return texto.length >= 4 && texto.length <= 16 ? texto : null;
}

/**
 * O nome de um provedor indicado, como QUEM INDICOU pode vê-lo: as duas
 * primeiras letras de cada palavra. O bastante para reconhecer quem ele
 * trouxe, sem a tela de um provedor virar a lista de clientes do outro.
 */
export function maskName(nome) {
  return String(nome ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 4)
    .map((palavra) => `${Array.from(palavra).slice(0, 2).join('')}•••`)
    .join(' ') || '•••';
}

/** O endereço do cadastro com o código — ou nulo, quando o deploy não sabe o próprio. */
export function signupUrlFor(code) {
  if (!code) return null;
  const host = panelBaseDomain() || platformExtraHosts()[0] || null;
  if (!host) return null;
  return `https://${host}/signup?ref=${encodeURIComponent(code)}`;
}

class ReferralService {
  /**
   * O código de indicação do provedor — gerado agora, se ainda não tem.
   * Atualização condicional (`referral_code IS NULL`): dois cliques ao mesmo
   * tempo ficam com o mesmo código, o de quem gravou primeiro. A colisão com
   * o código de outro provedor (índice único) tenta outro.
   */
  static async codeFor(tenantId) {
    const db = getDb();
    const linha = await db('tenants').where({ id: tenantId }).first('referral_code', 'kind');
    if (!linha) return null;
    if (linha.referral_code) return linha.referral_code;
    if (linha.kind === 'platform') return null;
    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop -- só repete na colisão
        await db('tenants').where({ id: tenantId }).whereNull('referral_code')
          .update({ referral_code: generateReferralCode() });
        break;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    const depois = await db('tenants').where({ id: tenantId }).first('referral_code');
    return depois?.referral_code ?? null;
  }

  /** O provedor dono de um código — ativo e cliente —, ou nulo. */
  static async findReferrer(code, trx = null) {
    const normalizado = normalizeReferralCode(code);
    if (!normalizado) return null;
    const linha = await (trx || getDb())('tenants').where({ referral_code: normalizado }).first();
    if (!linha || linha.kind !== 'provider' || linha.status !== 'active') return null;
    return linha;
  }

  /**
   * Liga o provedor recém-cadastrado a quem o indicou, na transação do
   * cadastro. Código inválido, de provedor inativo, ou a indicação de si
   * mesmo — o mesmo provedor, o mesmo CNPJ, ou um e-mail que já é da equipe
   * de quem indicou — é ignorada em silêncio: o cadastro segue igual, só sem
   * indicação. Devolve o id de quem indicou, ou nulo.
   */
  static async attachAtSignup({
    trx, tenantId, code, email = null, taxId = null
  }) {
    if (!code) return null;
    const quem = await ReferralService.findReferrer(code, trx);
    if (!quem || Number(quem.id) === Number(tenantId)) return null;
    if (taxId && quem.billing_tax_id && String(quem.billing_tax_id) === String(taxId)) return null;
    if (email) {
      const daEquipe = await trx('tenant_users')
        .join('users', 'users.id', 'tenant_users.user_id')
        .where('tenant_users.tenant_id', quem.id)
        .whereRaw('LOWER(users.email) = ?', [String(email).toLowerCase()])
        .first('users.id');
      if (daEquipe) return null;
    }
    await trx('tenants').where({ id: tenantId }).update({ referred_by_tenant_id: quem.id });
    await trx('referral_rewards').insert({
      referrer_tenant_id: quem.id,
      referred_tenant_id: tenantId,
      amount_cents: 0,
      status: 'pending',
      created_at: new Date()
    });
    return Number(quem.id);
  }

  /**
   * O que o pagamento do indicado precisa saber ANTES da transação — quem o
   * indicou e quanto vale a recompensa —, lido fora dela: no SQLite a
   * transação segura a única conexão, e a leitura da configuração por fora
   * esperaria para sempre. Nulo quando não há o que recompensar.
   */
  static async prepareReward(tenantId) {
    const linha = await getDb()('tenants').where({ id: tenantId }).first('referred_by_tenant_id');
    const referrerId = Number(linha?.referred_by_tenant_id ?? 0);
    if (!referrerId || referrerId === Number(tenantId)) return null;
    const recompensa = await getDb()('referral_rewards').where({ referred_tenant_id: tenantId }).first();
    if (recompensa && recompensa.status !== 'pending') return null;
    return { referrerId, amountCents: await referralRewardCents() };
  }

  /**
   * A recompensa, NA TRANSAÇÃO do pagamento que estendeu o período do
   * indicado. A linha `pending` vira `credited` por atualização condicional —
   * só a primeira passagem a muda — e o crédito nasce no escopo de quem
   * indicou. Com o programa desligado (valor zero), a linha vira `canceled`:
   * a recompensa é do PRIMEIRO pagamento, e ligar o programa depois não paga
   * a indicação velha.
   *
   * A linha que falte (indicado de antes desta tabela) é criada aqui, num
   * savepoint: a colisão do índice único numa corrida não pode derrubar a
   * transação do pagamento — no Postgres, um erro dentro dela a invalida
   * inteira.
   *
   * @returns {Promise<object|null>} o que entra no detalhe do evento.
   */
  static async rewardOnPayment({
    trx, tenantId, prepared, externalId = null, now = new Date()
  }) {
    if (!prepared) return null;
    const { referrerId, amountCents } = prepared;
    const existe = await trx('referral_rewards').where({ referred_tenant_id: tenantId }).first();
    if (!existe) {
      try {
        await trx.transaction(async (sp) => {
          await sp('referral_rewards').insert({
            referrer_tenant_id: referrerId,
            referred_tenant_id: tenantId,
            amount_cents: 0,
            status: 'pending',
            created_at: now
          });
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    const valor = Number.isInteger(amountCents) && amountCents > 0 ? amountCents : 0;
    if (!valor) {
      const mudou = await trx('referral_rewards')
        .where({ referred_tenant_id: tenantId, status: 'pending' })
        .update({ status: 'canceled', canceled_at: now, payment_external_id: externalId ? String(externalId).slice(0, 160) : null });
      return mudou ? { referralRewardSkipped: 'program_off' } : null;
    }
    const mudou = await trx('referral_rewards')
      .where({ referred_tenant_id: tenantId, status: 'pending' })
      .update({
        status: 'credited',
        amount_cents: valor,
        credited_at: now,
        payment_external_id: externalId ? String(externalId).slice(0, 160) : null
      });
    if (!mudou) return null;
    const recompensa = await trx('referral_rewards').where({ referred_tenant_id: tenantId }).first();
    const creditId = await runInTenant(recompensa.referrer_tenant_id, () => TenantCredit.add({
      amountCents: valor,
      source: 'referral',
      reference: `referral:${recompensa.id}`,
      at: now
    }, trx));
    await trx('referral_rewards').where({ id: recompensa.id }).update({ credit_id: creditId });
    return {
      referralReward: {
        id: Number(recompensa.id), referrerTenantId: Number(recompensa.referrer_tenant_id), amountCents: valor
      }
    };
  }

  /**
   * O estorno do pagamento que gerou a recompensa, NA TRANSAÇÃO do estorno do
   * indicado: a recompensa vira `canceled` e o que sobra do crédito (o que
   * não foi reservado nem gasto) é cancelado. O já usado fica — a fatura de
   * quem indicou foi emitida e paga com ele, e desfazê-la não é decisão desta
   * linha. Pela referência do pagamento, ou do aceite da diferença dele.
   *
   * @returns {Promise<object|null>} o que entra no detalhe do evento do estorno.
   */
  static async cancelOnRefund({
    trx, tenantId, reference, now = new Date()
  }) {
    const referencia = String(reference ?? '').trim();
    if (!referencia) return null;
    const recompensa = await trx('referral_rewards')
      .where({ referred_tenant_id: tenantId, status: 'credited' })
      .whereIn('payment_external_id', [referencia.slice(0, 160), `${referencia}:accepted`.slice(0, 160)])
      .first();
    if (!recompensa) return null;
    const mudou = await trx('referral_rewards').where({ id: recompensa.id, status: 'credited' })
      .update({ status: 'canceled', canceled_at: now });
    if (!mudou) return null;
    const cancelado = recompensa.credit_id
      ? await runInTenant(recompensa.referrer_tenant_id, () => TenantCredit.cancel(recompensa.credit_id, trx, { at: now }))
      : 0;
    return {
      referralRewardCanceled: {
        id: Number(recompensa.id),
        referrerTenantId: Number(recompensa.referrer_tenant_id),
        amountCents: Number(recompensa.amount_cents),
        canceledCents: cancelado,
        ...(recompensa.credit_id ? { creditId: Number(recompensa.credit_id) } : {})
      }
    };
  }

  /**
   * Depois do estorno que cancelou o crédito de uma indicação
   * (`cancelOnRefund`): as cobranças EM ABERTO de quem indicou que ainda
   * seguram uma reserva desse crédito voltam ao preço sem ele. A reserva de
   * um crédito cancelado não pode virar desconto quando a fatura for paga.
   *
   *   - a linha que ainda não foi ao gateway: a reserva solta e o valor volta
   *     ao preço sem crédito — a emissão reserva de novo, do saldo que houver;
   *   - a já emitida: cancelada no gateway e reemitida pela porta de sempre
   *     (`resetForReissue` solta as reservas, e a emissão reserva de novo).
   *
   * Fora da transação do estorno (fala com o gateway), e melhor esforço: a
   * falha fica no log, com o que alguém precisa para acertar à mão.
   *
   * @returns {Promise<number[]>} os ids das cobranças reprecificadas.
   */
  static async releaseCanceledCreditReservations({ referrerTenantId, creditId, now = new Date() }) {
    if (!referrerTenantId || !creditId) return [];
    const { default: BillingCharge, OPEN_CHARGE_STATUSES } = await import('../models/BillingCharge.js');
    const { default: ChargeIssuingService } = await import('./chargeIssuingService.js');
    const { default: Tenant } = await import('../models/Tenant.js');
    const { providerFor } = await import('./billing/registry.js');
    return runInTenant(referrerTenantId, async () => {
      const reservas = await tdb('credit_allocations').where({ credit_id: creditId, status: 'reserved' });
      const feitas = [];
      for (const chargeId of [...new Set(reservas.map((r) => Number(r.charge_id)))]) {
        try {
          // eslint-disable-next-line no-await-in-loop -- uma ou duas cobranças
          const linha = await BillingCharge.findById(chargeId);
          if (!linha || !OPEN_CHARGE_STATUSES.includes(linha.status)) continue;
          const semCredito = BillingCharge.baseAmountOf(linha);
          if (!linha.gateway_charge_id) {
            // eslint-disable-next-line no-await-in-loop
            await TenantCredit.releaseForCharge(chargeId);
            // eslint-disable-next-line no-await-in-loop
            await BillingCharge.update(chargeId, { amount_cents: semCredito });
            feitas.push(chargeId);
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          const minha = await BillingCharge.claim(chargeId, {
            until: new Date(now.getTime() + ChargeIssuingService.CLAIM_MS), now, unissued: false, openOnly: true
          });
          if (!minha) {
            console.warn(`Charge ${chargeId} holds a canceled referral credit but is busy; it keeps the reservation for now`);
            continue;
          }
          const provider = providerFor(linha.provider);
          if (typeof provider?.cancelCharge === 'function') {
            // eslint-disable-next-line no-await-in-loop
            await provider.cancelCharge(linha.gateway_charge_id);
          }
          // eslint-disable-next-line no-await-in-loop
          await BillingCharge.resetForReissue(chargeId, { amountCents: semCredito, currency: linha.currency });
          // eslint-disable-next-line no-await-in-loop
          const tenant = await Tenant.findById(referrerTenantId);
          // eslint-disable-next-line no-await-in-loop
          await ChargeIssuingService.issueCurrent({ tenant, manual: true, now });
          feitas.push(chargeId);
        } catch (error) {
          console.error(
            `Charge ${chargeId} of provider ${referrerTenantId} still reserves the canceled referral credit ${creditId}: ${error.message}`
          );
        }
      }
      return feitas;
    });
  }

  /** As indicações de quem indicou, com o nome do provedor indicado. */
  static async referralsOf(tenantId) {
    return getDb()('referral_rewards')
      .leftJoin('tenants', 'tenants.id', 'referral_rewards.referred_tenant_id')
      .where('referral_rewards.referrer_tenant_id', tenantId)
      .orderBy('referral_rewards.id', 'desc')
      .select(
        'referral_rewards.*',
        'tenants.name as referred_name',
        'tenants.slug as referred_slug'
      );
  }

  /** Quem indicou este provedor, e a recompensa daquela indicação. */
  static async referredBy(tenantId) {
    const linha = await getDb()('referral_rewards')
      .leftJoin('tenants', 'tenants.id', 'referral_rewards.referrer_tenant_id')
      .where('referral_rewards.referred_tenant_id', tenantId)
      .first('referral_rewards.*', 'tenants.name as referrer_name', 'tenants.slug as referrer_slug');
    return linha || null;
  }

  /**
   * A tela de Plano do provedor: o link, o saldo e os indicados — com o nome
   * mascarado. Gera o código na primeira vez. No escopo do provedor.
   */
  static async presentForTenant(tenantId) {
    const code = await ReferralService.codeFor(tenantId);
    const rewardCents = await referralRewardCents();
    const indicacoes = await ReferralService.referralsOf(tenantId);
    const [balanceCents, reservedCents, creditos] = await runInTenant(tenantId, async () => [
      await TenantCredit.balance(),
      await TenantCredit.reservedTotal(),
      await TenantCredit.list({ limit: 50 })
    ]);
    return {
      enabled: rewardCents > 0,
      rewardCents,
      code,
      signupUrl: signupUrlFor(code),
      balanceCents,
      reservedCents,
      referrals: indicacoes.map((linha) => ({
        id: linha.id,
        name: maskName(linha.referred_name),
        status: linha.status,
        amountCents: Number(linha.amount_cents ?? 0),
        createdAt: linha.created_at ?? null,
        creditedAt: linha.credited_at ?? null
      })),
      credits: creditos.map(TenantCredit.present)
    };
  }

  /** O mesmo, visto do console: nomes inteiros, alocações e quem indicou. */
  static async presentForConsole(tenantId) {
    const tenant = await getDb()('tenants').where({ id: tenantId }).first('referral_code');
    const indicacoes = await ReferralService.referralsOf(tenantId);
    const indicadoPor = await ReferralService.referredBy(tenantId);
    const [balanceCents, reservedCents, creditos, alocacoes] = await runInTenant(tenantId, async () => [
      await TenantCredit.balance(),
      await TenantCredit.reservedTotal(),
      await TenantCredit.list({ limit: 200 }),
      await TenantCredit.allocations({ limit: 200 })
    ]);
    const recompensa = (linha) => ({
      id: linha.id,
      status: linha.status,
      amountCents: Number(linha.amount_cents ?? 0),
      paymentExternalId: linha.payment_external_id ?? null,
      createdAt: linha.created_at ?? null,
      creditedAt: linha.credited_at ?? null,
      canceledAt: linha.canceled_at ?? null
    });
    return {
      code: tenant?.referral_code ?? null,
      rewardCents: await referralRewardCents(),
      balanceCents,
      reservedCents,
      referredBy: indicadoPor ? {
        ...recompensa(indicadoPor),
        tenantId: Number(indicadoPor.referrer_tenant_id),
        name: indicadoPor.referrer_name ?? null,
        slug: indicadoPor.referrer_slug ?? null
      } : null,
      referrals: indicacoes.map((linha) => ({
        ...recompensa(linha),
        tenantId: Number(linha.referred_tenant_id),
        name: linha.referred_name ?? null,
        slug: linha.referred_slug ?? null
      })),
      credits: creditos.map(TenantCredit.present),
      allocations: alocacoes.map(TenantCredit.presentAllocation)
    };
  }

  /**
   * O ajuste manual do console, no escopo do provedor: positivo é um crédito
   * novo (`manual`); negativo tira do saldo livre — e recusa
   * (`insufficient_credit`) o que passar dele: o console não deixa um saldo
   * negativo, que a próxima fatura não teria como cobrar.
   *
   * @returns {Promise<{ creditId: number, amountCents: number, balanceBefore: number, balanceAfter: number }>}
   */
  static async adjust({
    tenantId, amountCents, reason, actorUserId = null, now = new Date()
  }) {
    const valor = Number(amountCents);
    return runInTenant(tenantId, () => getDb().transaction(async (trx) => {
      const antes = await TenantCredit.balance(trx);
      if (valor < 0) {
        if (antes < -valor) {
          const erro = new Error('The adjustment is larger than the available credit');
          erro.code = 'insufficient_credit';
          erro.balanceCents = antes;
          throw erro;
        }
        const tirado = await TenantCredit.debit(-valor, trx);
        if (tirado !== -valor) {
          const erro = new Error('The credit changed while adjusting; try again');
          erro.code = 'busy';
          throw erro;
        }
      }
      const creditId = await TenantCredit.add({
        amountCents: valor,
        source: 'manual',
        reference: reason,
        createdBy: actorUserId,
        remainingCents: valor > 0 ? valor : 0,
        at: now
      }, trx);
      const depois = await TenantCredit.balance(trx);
      return {
        creditId: Number(creditId), amountCents: valor, balanceBefore: antes, balanceAfter: depois
      };
    }));
  }
}

export default ReferralService;

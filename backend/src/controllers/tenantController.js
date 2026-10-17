import Tenant from '../models/Tenant.js';
import TenantUser from '../models/TenantUser.js';
import User from '../models/User.js';
import { normalizeRole } from '../config/permissions.js';
import { createResponse, createErrorResponse, isValidEmail } from '../utils/helpers.js';
import TenantExportService from '../services/tenantExportService.js';
import AuditLog from '../models/AuditLog.js';
import SubscriptionService from '../services/subscriptionService.js';
import BillingCharge from '../models/BillingCharge.js';
import BillingInvoice from '../models/BillingInvoice.js';
import DeviceService from '../services/deviceService.js';
import SelfBillingService, { SelfBillingError } from '../services/selfBillingService.js';
import ChargeIssuingService from '../services/chargeIssuingService.js';
import CouponService, { couponTrail } from '../services/couponService.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { translateError } from '../i18n/index.js';
import { EDITION } from '../config/edition.js';
import { panelBaseDomain, usesTenantSubdomains } from '../middleware/tenantResolver.js';
import { normalizeTaxId, isValidTaxId, isValidCnpj } from '../utils/taxId.js';
import { lookupCnpj } from '../services/cnpjLookupService.js';
import { lookupCep, geocodeAddress } from '../services/addressLookupService.js';
import ReferralService from '../services/referralService.js';

/**
 * O cadastro fiscal vindo do corpo, normalizado — ou o motivo de recusa.
 *
 * Recebe camelCase da tela e devolve as colunas do banco. Campo ausente não é
 * tocado; campo presente e vazio vira nulo, que é como se apaga o que foi
 * preenchido por engano. Essa diferença é o contrato inteiro desta função, e é
 * por isso que ela não monta um objeto completo com defaults.
 *
 * O CNPJ (ou CPF, do MEI) é o único campo conferido além do tamanho, e é por
 * onde a nota fiscal falha: um dígito trocado só aparece no dia da emissão,
 * quando quem conserta já é o financeiro e não quem digitou.
 */
const CAMPOS_FATURAMENTO = [
  ['legalName', 'billing_legal_name', 160],
  ['taxId', 'billing_tax_id', 20],
  ['stateRegistration', 'billing_state_registration', 32],
  ['postalCode', 'billing_postal_code', 8],
  ['addressLine', 'billing_address_line', 160],
  ['addressNumber', 'billing_address_number', 16],
  ['addressExtra', 'billing_address_extra', 80],
  ['district', 'billing_district', 80],
  ['city', 'billing_city', 80],
  ['state', 'billing_state', 2],
  ['email', 'billing_email', 160],
  ['phone', 'billing_phone', 32]
];

function billingPatch(entrada) {
  if (typeof entrada !== 'object' || Array.isArray(entrada)) {
    return { error: 'tenant.billingInvalid' };
  }
  const patch = {};
  for (const [chave, coluna, limite] of CAMPOS_FATURAMENTO) {
    if (!(chave in entrada)) continue;
    const bruto = entrada[chave];
    if (bruto === null || bruto === undefined || String(bruto).trim() === '') {
      patch[coluna] = null;
      continue;
    }
    let valor = String(bruto).trim();

    // Os três que o banco guarda sem enfeite, porque é assim que se comparam.
    if (coluna === 'billing_tax_id' || coluna === 'billing_postal_code') {
      valor = normalizeTaxId(valor);
    }
    if (coluna === 'billing_state') valor = valor.toUpperCase();

    if (valor.length > limite) return { error: 'tenant.billingInvalid' };
    if (coluna === 'billing_tax_id' && !isValidTaxId(valor)) {
      return { error: 'tenant.billingTaxIdInvalid' };
    }
    if (coluna === 'billing_postal_code' && valor.length !== 8) {
      return { error: 'tenant.billingPostalCodeInvalid' };
    }
    if (coluna === 'billing_state' && !/^[A-Z]{2}$/.test(valor)) {
      return { error: 'tenant.billingInvalid' };
    }
    if (coluna === 'billing_email' && !isValidEmail(valor)) {
      return { error: 'tenant.billingEmailInvalid' };
    }
    patch[coluna] = valor;
  }
  return { patch };
}

/**
 * What a provider will admit to before anybody has signed in.
 *
 * The login screen has to render the provider's own name, and it has to do so
 * with no token — so this is the one route that answers a stranger with
 * something drawn from the `tenants` row. That makes it the enumeration surface
 * of the whole deployment, and everything below is written against that.
 */
const NAME_MAX_LENGTH = 128;

/**
 * O corpo de `GET /api/tenant/subscription` — e o de `PUT
 * /api/tenant/subscription/plan`, que devolve a mesma tela depois da troca.
 * Uma função e não duas cópias: a tela que troca de plano redesenha com o que
 * volta, e um campo que só uma das rotas mandasse sumiria da tela no clique.
 */
async function subscriptionPayload(req) {
  const usage = await SubscriptionService.usage({
    countDevices: () => DeviceService.countDevicesFromGenieAcs()
  });
  // O cadastro fiscal viaja aqui e não numa rota própria porque é a mesma
  // tela: "plano e uso" é onde o provedor olha a parte comercial dele, e uma
  // porta a mais no inventário custa mais do que quatro campos a mais num
  // corpo que esta tela já busca.
  const provedor = await Tenant.findById(req.tenantId);
  return { ...usage, billing: Tenant.presentBilling(provedor) };
}

/**
 * A recusa do autoatendimento de cobrança, no envelope de sempre: a mensagem
 * no idioma de quem pediu, o código que a tela lê e, quando há, os números no
 * topo do corpo (`resource`, `used`, `limit` do `over_limit`).
 */
function selfBillingRefusal(req, res, error) {
  return res.status(error.status || 400).json({
    ...createErrorResponse(translateError(req.t, error), error.detail ?? null, error.code),
    ...(error.extra ?? {})
  });
}

/**
 * A frase da troca de plano, que diz O QUE aconteceu — e são quatro coisas
 * diferentes para quem clicou: trocou agora, vai trocar na renovação (com a
 * data), desistiu da troca agendada, ou nada mudou.
 *
 * A data vai no idioma e no fuso da cobrança: é o dia em que a renovação
 * acontece em São Paulo, o mesmo que a fatura mostra, e não o do servidor.
 */
function planChangeMessage(req, resultado) {
  if (resultado.pendingCanceled) return req.t('subscription.pendingCanceled');
  if (resultado.scheduled) {
    return req.t('subscription.planScheduled', { date: formatBillingDate(resultado.effectiveAt, req.locale) });
  }
  return req.t(resultado.changed ? 'subscription.planChanged' : 'subscription.planUnchanged');
}

function formatBillingDate(value, locale) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale || 'pt-BR', {
      timeZone: ChargeIssuingService.BILLING_TIMEZONE, dateStyle: 'short'
    }).format(date);
  } catch {
    return ChargeIssuingService.isoDate(date);
  }
}

/** Quem liga e desliga a exigência do 2FA: o `owner`, ou o `admin` onde não há `owner`. */
async function governaSeguranca(tenantId, role) {
  const papel = normalizeRole(role);
  if (papel === 'owner') return true;
  if (papel !== 'admin') return false;
  return (await TenantUser.countByRole(tenantId, 'owner')) === 0;
}

class TenantController {
  /**
   * `PATCH /api/tenant` — the provider renames itself.
   *
   * This is what `settings.appName` used to be: the name on the sidebar, the
   * login screen and the browser tab. It moves onto the `tenants` row because
   * that row is the provider — the console lists it, the public profile
   * answers it, and a name kept in two places was a name shown differently on
   * two screens. Audited on the provider's own trail: renaming is not
   * sensitive, but it is the kind of change somebody asks "who did that" about.
   */
  /**
   * Os dados públicos de um CNPJ, para preencher o cadastro — sem gravar.
   *
   * 400 para o número que nem é um CNPJ (não vale gastar a consulta), 404
   * quando a Receita não o conhece e 502 quando a consulta falhou; em
   * nenhum dos casos o cadastro deixa de poder ser digitado à mão.
   */
  static async lookupCnpj(req, res) {
    const cnpj = normalizeTaxId(req.query?.cnpj);
    if (!isValidCnpj(cnpj)) {
      return res.status(400).json(createErrorResponse(req.t('tenant.billingTaxIdInvalid')));
    }
    try {
      const result = await lookupCnpj(cnpj);
      if (!result.found) {
        return res.status(404).json(createErrorResponse(req.t('tenant.cnpjNotFound')));
      }
      return res.json(createResponse(req.t('tenant.cnpjFound'), { taxId: cnpj, ...result.data }));
    } catch (error) {
      return res.status(502).json(createErrorResponse(req.t('tenant.cnpjLookupFailed'), error.message));
    }
  }

  /**
   * `GET /api/tenant/security` — se o provedor exige o 2FA da equipe, e
   * quantas pessoas da equipe ainda não o ativaram (o que o dono quer saber
   * antes de ligar a exigência, e depois, para cobrar quem falta).
   */
  static async getSecurity(req, res) {
    try {
      const [requireMfa, equipe] = await Promise.all([
        Tenant.requiresMfa(req.tenantId),
        TenantUser.listForTenant(req.tenantId)
      ]);
      return res.json(createResponse(null, {
        requireMfa,
        membersWithoutMfa: equipe.filter((membro) => !membro.totp_enabled_at).length,
        // Se quem pergunta pode mudar — a tela mostra a chave ou só o estado.
        canChange: await governaSeguranca(req.tenantId, req.user.role)
      }));
    } catch (error) {
      console.error('Tenant security error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * `PUT /api/tenant/security` — o dono liga ou desliga a exigência do 2FA.
   *
   * "O dono" é o `owner` — e, num provedor sem nenhum `owner`, o `admin`. O
   * `/setup` de uma instalação nova cria o primeiro operador como `admin` (só
   * as instalações anteriores à 0030 e o cadastro da edição SaaS têm um
   * `owner`), e sem essa segunda metade ninguém ali conseguiria ligar a
   * exigência.
   *
   * Só o `owner`, conferido aqui como em `usersController` (`users.ownerOnly`):
   * `settings.write` é também do `admin`, e é justamente de quem administra que
   * o dono pode querer exigir o segundo fator.
   *
   * Ligar exige que o próprio dono já use o 2FA — senão o primeiro clique o
   * trancaria na tela de ativação no meio do que estava fazendo.
   */
  static async updateSecurity(req, res) {
    try {
      const pedido = req.body?.requireMfa;
      if (typeof pedido !== 'boolean') {
        return res.status(400).json(createErrorResponse(req.t('tenant.securityInvalid')));
      }
      if (!(await governaSeguranca(req.tenantId, req.user.role))) {
        return res.status(403).json(createErrorResponse(req.t('users.ownerOnly')));
      }
      if (pedido) {
        const eu = await User.findById(req.user.userId);
        if (!eu?.totp_enabled_at) {
          return res.status(409).json(
            createErrorResponse(req.t('tenant.mfaEnableYourselfFirst'), null, 'mfa_enable_yourself_first')
          );
        }
      }
      const antes = await Tenant.requiresMfa(req.tenantId);
      if (antes !== pedido) {
        await Tenant.setRequireMfa(req.tenantId, pedido);
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.TENANT_MFA_REQUIRED_CHANGED,
          subjectType: 'tenant',
          subjectId: req.tenantId,
          detail: { from: antes, to: pedido }
        });
      }
      return res.json(createResponse(req.t('tenant.securityUpdated'), { requireMfa: pedido }));
    } catch (error) {
      console.error('Tenant security update error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /** O endereço de um CEP, para preencher o cadastro — sem gravar. */
  static async lookupCep(req, res) {
    const cep = String(req.query?.cep ?? '').replace(/\D/g, '');
    if (cep.length !== 8) {
      return res.status(400).json(createErrorResponse(req.t('tenant.cepInvalid')));
    }
    try {
      const result = await lookupCep(cep);
      if (!result.found) {
        return res.status(404).json(createErrorResponse(req.t('tenant.cepNotFound')));
      }
      return res.json(createResponse(req.t('tenant.cepFound'), result.data));
    } catch (error) {
      return res.status(502).json(createErrorResponse(req.t('tenant.cepLookupFailed'), error.message));
    }
  }

  /**
   * O ponto no mapa de um endereço, para posicionar a sede — sem gravar.
   * Cidade e UF são o mínimo: sem elas, não há onde procurar.
   */
  static async geocode(req, res) {
    const campos = {};
    for (const chave of ['addressLine', 'addressNumber', 'district', 'city', 'state', 'postalCode']) {
      campos[chave] = String(req.query?.[chave] ?? '').slice(0, 160);
    }
    if (!campos.city.trim() || !campos.state.trim()) {
      return res.status(400).json(createErrorResponse(req.t('tenant.geocodeNeedsCity')));
    }
    try {
      const result = await geocodeAddress(campos);
      if (!result.found) {
        return res.status(404).json(createErrorResponse(req.t('tenant.geocodeNotFound')));
      }
      return res.json(createResponse(req.t('tenant.geocodeFound'), result.data));
    } catch (error) {
      return res.status(502).json(createErrorResponse(req.t('tenant.geocodeFailed'), error.message));
    }
  }

  static async rename(req, res) {
    try {
      const temNome = req.body?.name !== undefined;
      const temFaturamento = req.body?.billing !== undefined && req.body.billing !== null;
      if (!temNome && !temFaturamento) {
        return res.status(400).json(createErrorResponse(req.t('tenant.nameInvalid')));
      }

      const name = String(req.body?.name ?? '').trim();
      if (temNome && (name.length < 1 || name.length > NAME_MAX_LENGTH)) {
        return res.status(400).json(createErrorResponse(req.t('tenant.nameInvalid')));
      }

      let faturamento = null;
      if (temFaturamento) {
        const analise = billingPatch(req.body.billing);
        if (analise.error) {
          return res.status(400).json(createErrorResponse(req.t(analise.error)));
        }
        faturamento = analise.patch;
      }

      const before = await Tenant.findById(req.tenantId);
      if (!before) {
        return res.status(404).json(createErrorResponse(req.t('common.notFound')));
      }

      if (temNome) {
        await Tenant.rename(req.tenantId, name);
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.TENANT_RENAMED,
          subjectType: 'tenant',
          subjectId: req.tenantId,
          detail: { from: before.name, to: name }
        });
      }

      if (faturamento && Object.keys(faturamento).length) {
        await Tenant.updateBilling(req.tenantId, faturamento);
        // Os campos, nunca os valores. A trilha existe para responder "quem
        // mexeu no meu cadastro fiscal", e para isso o nome do campo basta —
        // repetir o CNPJ e o endereço em cada linha faria da trilha uma
        // segunda cópia do cadastro, com retenção maior que a dele.
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.TENANT_BILLING_CHANGED,
          subjectType: 'tenant',
          subjectId: req.tenantId,
          detail: { fields: Object.keys(faturamento).sort() }
        });
      }

      const depois = await Tenant.findById(req.tenantId);
      return res.json(createResponse(req.t('tenant.renamed'), {
        name: depois?.name ?? before.name,
        slug: before.slug,
        billing: Tenant.presentBilling(depois)
      }));
    } catch (error) {
      console.error('Rename tenant error:', error);
      return res.status(500).json(createErrorResponse(req.t('tenant.renameFailed'), error.message));
    }
  }

  /**
   * `GET /api/tenant/subscription`: o plano, o estado e o uso — a tela de
   * "plano e uso" do provedor, e a placa que a tela de bloqueio lê.
   *
   * A contagem de ONTs vem do GenieACS e pode falhar; ela vira `null` sem
   * derrubar o resto (ver `SubscriptionService.usage`). O preço não vem aqui,
   * e não por segredo — ele está em `GET /api/tenant/plans`, a lista de onde
   * o provedor escolhe o plano: esta é a tela do estado, aquela a do catálogo.
   */
  static async getSubscription(req, res) {
    try {
      return res.json(createResponse(req.t('subscription.retrieved'), await subscriptionPayload(req)));
    } catch (error) {
      console.error('Get subscription error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('subscription.retrieveFailed'), error.message)
      );
    }
  }

  /**
   * `GET /api/tenant/referrals` — a indicação de provedores, na tela de Plano
   * (0106): o código e o link (gerados na primeira vez), o saldo de créditos
   * e quem este provedor indicou, com o nome mascarado. `settings.read`, como
   * `/subscription`: é a mesma tela.
   */
  static async getReferrals(req, res) {
    try {
      return res.json(createResponse(req.t('referrals.retrieved'), await ReferralService.presentForTenant(req.tenantId)));
    } catch (error) {
      console.error('Get referrals error:', error);
      return res.status(500).json(createErrorResponse(req.t('referrals.retrieveFailed'), error.message));
    }
  }

  /**
   * `GET /api/tenant/plans`: o catálogo de onde o provedor escolhe, com o
   * preço de cada plano e o dele marcado — ver `SelfBillingService.listPlans`
   * para por que o atual entra mesmo fora de linha.
   *
   * `settings.read`, a mesma de `/subscription`. E fora da porta da
   * assinatura, porque quem está em `past_due` é quem mais precisa comparar
   * preços antes de pagar.
   */
  static async listPlans(req, res) {
    try {
      return res.json(createResponse(req.t('plans.retrieved'), await SelfBillingService.listPlans()));
    } catch (error) {
      console.error('List plans (tenant) error:', error);
      return res.status(500).json(createErrorResponse(req.t('plans.retrieveFailed'), error.message));
    }
  }

  /**
   * `PUT /api/tenant/subscription/plan` — `{ planId, cycle? }`: o provedor troca de
   * plano — na hora quando sobe, na renovação quando desce com um período
   * pago correndo (`subscription.pendingPlan` na resposta), e escolher o plano
   * atual com uma descida agendada desiste dela.
   *
   * A regra é de `SelfBillingService.changePlan`; aqui ficam as duas trilhas.
   * A do provedor, porque "quem trocou o nosso plano" é pergunta que o dono
   * faz — com o ator de sempre, quem estava logado. E a da plataforma, com a
   * mesma ação que o console grava quando é ele quem troca: o que o provedor
   * paga mudou, e é na trilha da plataforma que se reconstrói a receita de um
   * cliente. `selfService: true` é o que separa as duas origens ali, já que o
   * ator é um operador do provedor e não alguém do console.
   *
   * Nenhuma das duas carrega preço: o plano é o fato, o preço é do catálogo.
   */
  static async changePlan(req, res) {
    try {
      const resultado = await SelfBillingService.changePlan({
        planId: req.body?.planId,
        // O ciclo (0104): `monthly` ou `annual`; sem ele, o de agora.
        cycle: req.body?.cycle ?? null,
        actorUserId: req.user?.userId ?? null,
        countDevices: () => DeviceService.countDevicesFromGenieAcs()
      });

      // A desistência de uma descida agendada também vai para as duas trilhas:
      // o plano não mudou, mas o que o provedor vai pagar na renovação mudou,
      // e é essa a pergunta que a trilha da plataforma responde.
      if (resultado.changed || resultado.pendingCanceled) {
        const detail = {
          from: resultado.from,
          to: resultado.to,
          toCode: resultado.plan?.code ?? null,
          selfService: true,
          scheduled: Boolean(resultado.scheduled),
          billingCycle: resultado.billingCycle ?? null,
          ...(resultado.cycleFrom ? { cycleFrom: resultado.cycleFrom } : {}),
          ...(resultado.scheduled && resultado.effectiveAt
            ? { effectiveAt: new Date(resultado.effectiveAt).toISOString() } : {}),
          ...(resultado.pendingCanceled
            ? { pendingCanceled: true, canceledPlanId: resultado.canceledPlanId ?? null } : {}),
          ...(resultado.replacedPlanId ? { replacedPlanId: resultado.replacedPlanId } : {}),
          ...(resultado.deferredByUpgrade ? { deferredByUpgrade: true } : {}),
          ...(resultado.charge !== 'none' ? { openCharge: resultado.charge } : {}),
          // A pró-rata da subida (0101): quanto, e se saiu.
          ...(resultado.proration ? {
            proration: {
              amountCents: resultado.proration.amountCents,
              issued: resultado.proration.issued,
              ...(resultado.proration.skipped ? { skipped: resultado.proration.skipped } : {}),
              ...(resultado.proration.reason ? { reason: resultado.proration.reason } : {}),
              ...(resultado.proration.charge?.id ? { chargeId: resultado.proration.charge.id } : {})
            }
          } : {})
        };
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
          subjectType: 'subscription',
          subjectId: req.tenantId,
          detail
        });
        const provedor = await Tenant.findById(req.tenantId);
        const registrada = await PlatformAudit.fromRequest(req, {
          action: PlatformAudit.ACTIONS.SUBSCRIPTION_PLAN_CHANGED,
          tenant: provedor,
          detail
        });
        if (!registrada) console.warn(`Provider ${req.tenantId} changed its plan without a platform trail line`);
      }

      // `proration` (0101): a fatura de pró-rata que a subida abriu — com o
      // link de pagamento, para a tela levar o provedor direto a ela.
      return res.json(createResponse(planChangeMessage(req, resultado), {
        ...await subscriptionPayload(req),
        ...(resultado.proration ? { proration: resultado.proration } : {})
      }));
    } catch (error) {
      if (error instanceof SelfBillingError) return selfBillingRefusal(req, res, error);
      console.error('Self-service plan change error:', error);
      return res.status(500).json(createErrorResponse(req.t('subscription.planChangeFailed'), error.message));
    }
  }

  /**
   * `POST /api/tenant/subscription/coupon` — `{ code }`: o provedor aplica um
   * cupom de desconto (0093). Só quando ainda não tem um; trocar de cupom é
   * com o console. A fatura em aberto do prazo vivo é reprecificada pela
   * porta da troca de plano. As recusas são 409 com o código que a tela lê.
   *
   * As duas trilhas, como na troca de plano: a do provedor (quem aplicou) e a
   * da plataforma (o que este cliente paga mudou), com `selfService: true`.
   */
  static async applyCoupon(req, res) {
    try {
      const code = req.body?.code;
      if (typeof code !== 'string' || !code.trim()) {
        return selfBillingRefusal(req, res, new SelfBillingError('coupon.invalid', { code: 'coupon_invalid', status: 409 }));
      }
      const resultado = await CouponService.apply({
        tenantId: req.tenantId,
        code,
        actorUserId: req.user?.userId ?? null,
        source: 'provider',
        countDevices: () => DeviceService.countDevicesFromGenieAcs()
      });
      const detail = {
        coupon: couponTrail(resultado.coupon),
        priceCents: resultado.priceCents,
        selfService: true,
        ...(resultado.charge !== 'none' ? { openCharge: resultado.charge } : {})
      };
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
        subjectType: 'subscription',
        subjectId: req.tenantId,
        detail
      });
      const provedor = await Tenant.findById(req.tenantId);
      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.SUBSCRIPTION_COUPON_CHANGED,
        tenant: provedor,
        detail
      });
      if (!registrada) console.warn(`Provider ${req.tenantId} applied a coupon without a platform trail line`);
      return res.json(createResponse(req.t('coupon.applied', { code: resultado.coupon.code }), await subscriptionPayload(req)));
    } catch (error) {
      if (error instanceof SelfBillingError) return selfBillingRefusal(req, res, error);
      console.error('Apply coupon error:', error);
      return res.status(500).json(createErrorResponse(req.t('coupon.applyFailed'), error.message));
    }
  }

  /**
   * `PUT /api/tenant/subscription/autopay` — `{ enabled }`: liga ou desliga a
   * cobrança automática no cartão (0100). Mesma capacidade e mesmo lado da
   * porta da assinatura que a troca de plano.
   *
   * O IP gravado é o de quem pediu (`req.ip`, que respeita o `trust proxy` do
   * deploy): o gateway o exige em toda cobrança por token. A trilha do
   * provedor diz quem ligou ou desligou — sem cartão nem IP no `detail`.
   */
  static async setCardAutopay(req, res) {
    try {
      const resultado = await SelfBillingService.setCardAutopay({
        enabled: req.body?.enabled,
        remoteIp: req.ip
      });
      if (resultado.changed) {
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
          subjectType: 'subscription',
          subjectId: req.tenantId,
          detail: { cardAutopay: resultado.enabled, selfService: true }
        });
      }
      const chave = resultado.enabled ? 'subscription.cardAutopayEnabled' : 'subscription.cardAutopayDisabled';
      return res.json(createResponse(req.t(chave), await subscriptionPayload(req)));
    } catch (error) {
      if (error instanceof SelfBillingError) return selfBillingRefusal(req, res, error);
      console.error('Card autopay change error:', error.message);
      return res.status(500).json(createErrorResponse(req.t('subscription.cardUpdateFailed'), error.message));
    }
  }

  /**
   * `DELETE /api/tenant/subscription/card`: esquece o cartão salvo (0100). A
   * cobrança de cartão em aberto vira Pix/boleto. Idempotente — sem cartão,
   * 200 e nada muda. A trilha leva bandeira e quatro dígitos, nunca o token.
   */
  static async removeCard(req, res) {
    try {
      const resultado = await SelfBillingService.removeCard();
      if (resultado.removed) {
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
          subjectType: 'subscription',
          subjectId: req.tenantId,
          detail: { cardRemoved: true, brand: resultado.brand ?? null, last4: resultado.last4 ?? null, selfService: true }
        });
      }
      return res.json(createResponse(req.t('subscription.cardRemoved'), await subscriptionPayload(req)));
    } catch (error) {
      if (error instanceof SelfBillingError) return selfBillingRefusal(req, res, error);
      console.error('Remove card error:', error.message);
      return res.status(500).json(createErrorResponse(req.t('subscription.cardUpdateFailed'), error.message));
    }
  }

  /**
   * `POST /api/tenant/charges/pay` — "pagar agora": a cobrança em aberto do
   * período, a que já existe ou uma emitida neste clique, com o link.
   *
   * Sem corpo, e é de propósito: nada que o provedor mande decide valor,
   * período, gateway ou cliente no gateway. O valor é o do plano, o período o
   * da assinatura, e o cliente no gateway é criado (quando falta) com o
   * cadastro fiscal que já está na linha — ver `asaasCustomerService`.
   *
   * Quando o clique CRIOU o cliente no Asaas, a plataforma ganha a linha que
   * o botão do console grava: um cadastro foi aberto na conta dela, com o CNPJ
   * de alguém, e isso não pode acontecer sem rastro só porque quem clicou
   * estava do outro lado.
   */
  static async payNow(req, res) {
    try {
      const { charge, issued, customerCreated } = await SelfBillingService.payNow({
        countDevices: () => DeviceService.countDevicesFromGenieAcs()
      });
      if (customerCreated) {
        const provedor = await Tenant.findById(req.tenantId);
        const registrada = await PlatformAudit.fromRequest(req, {
          action: PlatformAudit.ACTIONS.TENANT_GATEWAY_CUSTOMER_CREATED,
          tenant: provedor,
          detail: { gateway: 'asaas', linked: true, selfService: true }
        });
        if (!registrada) console.warn(`Provider ${req.tenantId} gateway customer created without a platform trail line`);
      }
      return res.status(issued ? 201 : 200).json(createResponse(req.t('charges.payReady'), {
        charge: BillingCharge.present(charge)
      }));
    } catch (error) {
      if (error instanceof SelfBillingError) return selfBillingRefusal(req, res, error);
      console.error('Pay now error:', error);
      return res.status(500).json(createErrorResponse(req.t('charges.payFailed'), error.message));
    }
  }

  /**
   * `GET /api/tenant/charges`: as cobranças que o painel emitiu a este
   * provedor — de que período, quanto, até quando, e onde se paga.
   *
   * A tabela existe desde a emissão automática e guarda `invoice_url`, a
   * página do gateway onde se paga. Até aqui esse endereço só saía pelo e-mail
   * de aviso (`subscriptionNoticeService`): quem perdeu o e-mail via o muro do
   * 402 e não tinha, em tela nenhuma, onde pagar.
   *
   * `settings.read`, a mesma de `/subscription`: quem pode ver em que plano o
   * provedor está pode ver o que foi cobrado por ele. E, como aquela, fica
   * FORA da porta da assinatura — ver o comentário em `subscriptionGate.js`.
   */
  static async listCharges(req, res) {
    try {
      const cobrancas = await BillingCharge.listRecent({ limit: 24 });
      const notas = await BillingInvoice.forCharges(cobrancas.map((linha) => linha.id));
      return res.json(createResponse(req.t('charges.retrieved'), {
        charges: cobrancas.map((linha) => BillingCharge.present(linha, notas.get(Number(linha.id)) || null))
      }));
    } catch (error) {
      console.error('List charges error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('charges.retrieveFailed'), error.message)
      );
    }
  }

  /**
   * O cadastro inteiro deste provedor, num arquivo.
   *
   * `Content-Disposition: attachment` com o slug e a data no nome: o arquivo
   * costuma ir para um e-mail ou um chamado, e um `export.json` sem dono vira
   * três arquivos iguais na pasta de quem recebeu.
   *
   * Auditado, e é uma das ações mais sensíveis que existem aqui — devolve todo
   * o cadastro de assinantes de uma vez. Sem registro, um operador de saída
   * baixaria a base inteira e nada no painel diria que isso aconteceu.
   */
  static async exportTenant(req, res) {
    try {
      const arquivo = await TenantExportService.build();
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TENANT_EXPORTED,
        subjectType: 'tenant',
        subjectId: arquivo.manifest.tenant?.id ?? null,
        detail: { rowCounts: arquivo.manifest.rowCounts }
      });

      const nome = [
        'skygenpanel',
        arquivo.manifest.tenant?.slug || 'export',
        new Date().toISOString().slice(0, 10)
      ].join('-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nome}.json"`);
      return res.send(JSON.stringify(arquivo, null, 2));
    } catch (error) {
      console.error('Tenant export error:', error);
      return res.status(500).json(createErrorResponse(req.t('tenant.exportFailed'), error.message));
    }
  }

  /**
   * `GET /api/tenant/public`.
   *
   * There is no lookup here, and that is the design. The provider is whatever
   * `resolveTenant` already put on the request from the `Host` header; this
   * route accepts no slug, no id and no query of its own. A route that took the
   * provider from the caller would let anyone read any provider's row by asking
   * for it, which is precisely the hole the host-based resolver exists to close
   * — and it would close it nowhere else, because every other route would still
   * be scoped by host.
   *
   * The corollary is that an unknown host never gets this far: the resolver
   * answers 404 ahead of the routes, and so does a host naming a provider that
   * is not active, with the same body. Those two answers must stay identical,
   * because the difference between them is "this ISP is our customer and is
   * behind on its bill" — a fact about somebody else's business that we would
   * be publishing. Nothing in this file may introduce a way to tell them apart:
   * no status in the payload, no distinct message, no distinct status code, and
   * no branch that only a real-but-suspended provider can reach.
   *
   * On rate limiting: `/api` is already behind `apiLimiter` in `app.js`, mounted
   * above the resolver, so this route arrives limited at 300/min per
   * provider-and-address without anything further here. A second limiter on
   * this path specifically would be theatre for the threat that actually
   * matters. Enumeration does not need THIS route — the resolver's 404 is
   * visible on every path under `/api`, so a prober sweeping slugs would just
   * ask `/api/auth/login` and read the same signal at the same cost. The
   * ceiling that would bite a sweep is an address-keyed one ahead of the
   * resolver, since `apiLimiter`'s key folds in the slug and so hands a
   * prober a fresh budget for every slug guessed. That belongs where the
   * resolver is mounted, protecting every route at once; bolting it on here
   * would slow nothing down and would read as if the problem were solved.
   */
  static async getPublicProfile(req, res) {
    try {
      // The platform's own host: no provider, but the two facts a stranger
      // needs — that this is a SaaS, and where a provider's panel would live.
      // The screen turns that into "sign up here".
      if (req.platformHost) {
        return res.json(createResponse(req.t('tenant.publicRetrieved'), {
          slug: null,
          name: null,
          edition: EDITION,
          panelBaseDomain: panelBaseDomain()
        }));
      }

      const tenant = await Tenant.findPublicById(req.tenantId);

      // The row the resolver blessed is gone — a provider deleted while the
      // process was up, since the resolver caches slug to id for the life of
      // the process. Answered as the resolver would have answered had it read
      // the table a moment later, deliberately reusing `common.notFound`, so
      // this narrow race cannot become a third distinguishable outcome.
      if (!tenant) {
        return res.status(404).json(createErrorResponse(req.t('common.notFound')));
      }

      // Spelled out field by field rather than spread from the row. The model
      // already selects only the public columns, and this is the second of the
      // two locks on the same door: adding a field to what a stranger sees now
      // takes an edit here AND an edit there, and trips the test that pins the
      // exact key set.
      //
      // `id` is absent on purpose. The screen has no use for it — it renders a
      // name — and it is the stable primary key of a `tenants` row. Handing it
      // to unauthenticated callers invites clients to start sending it back,
      // and a tenant id in a request body is the exact shape of parameter that
      // becomes an IDOR the day some future route trusts it over the host. The
      // caller already named the provider by connecting to its host; the id
      // tells them nothing more about who they reached and gives them a handle
      // we would rather they never held.
      //
      // `slug` is present, and it is not a disclosure: on a deployment with
      // subdomains it is the very string the caller typed to get here, and on
      // one without, it is `default` for every install there has ever been. It
      // earns its place by being the stable key the client can cache branding
      // under, and by letting the screen say which provider it thinks it is
      // talking to when a proxy has rewritten the host underneath it.
      // Two more facts a stranger may know, both about the DEPLOYMENT rather
      // than about this provider. `edition` decides whether the screen offers
      // signup and whether it shows the database switcher — the SaaS edition is
      // not a secret, it is the product; every subdomain already says so.
      // `panelBaseDomain` is what signup needs to promise an address, and it is
      // the string in the caller's own address bar.
      // A porta COMPARTILHADA não veste ninguém.
      //
      // Num SaaS sem domínio-base todos os provedores entram pelo mesmo
      // endereço, e o que o resolvedor devolve aqui é o PRIMEIRO da tabela, por
      // fallback — não o provedor de quem está olhando, porque ninguém olhou
      // ainda. Mandar o nome dele punha a marca de um ISP na porta de todos os
      // outros: a equipe do segundo provedor via o nome do primeiro ao digitar
      // a senha.
      //
      // Só o NOME cai. O `slug` continua indo, e essa distinção é o ponto: a
      // tela deduz "aqui é a plataforma" de `slug === null`, então anulá-lo
      // trocaria o painel de todo mundo pela casca do console. Sem nome, a tela
      // cai sozinha no nome do produto.
      const compartilhado = EDITION === 'saas'
        && !usesTenantSubdomains()
        && (await Tenant.count()) > 1;

      return res.json(createResponse(req.t('tenant.publicRetrieved'), {
        name: compartilhado ? null : tenant.name,
        slug: tenant.slug,
        // `provider` ou `platform`. A tela precisa dele por uma razão só: a
        // caixa interna da plataforma não gerencia equipamento nenhum, e sem
        // isto o portão de onboarding a empurra para configurar um GenieACS
        // que ela nunca vai ter. Ver a justificativa em `Tenant.PUBLIC_COLUMNS`
        // para por que um fato do deploy pode sair numa rota aberta.
        kind: tenant.kind ?? 'provider',
        shared: compartilhado,
        edition: EDITION,
        panelBaseDomain: panelBaseDomain()
      }));
    } catch (error) {
      console.error('Get public tenant profile error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('tenant.publicFailed'), error.message)
      );
    }
  }
}

export default TenantController;

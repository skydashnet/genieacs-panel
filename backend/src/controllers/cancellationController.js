import Tenant from '../models/Tenant.js';
import TenantUser from '../models/TenantUser.js';
import AuditLog from '../models/AuditLog.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { normalizeRole } from '../config/permissions.js';
import { runInTenant } from '../config/tenantContext.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';
import CancellationService from '../services/cancellationService.js';
import SubscriptionService from '../services/subscriptionService.js';
import { SelfBillingError } from '../services/selfBillingService.js';
import DeviceService from '../services/deviceService.js';
import { recordBoth, subscriptionView } from './platformBillingController.js';

/**
 * A retenção no cancelamento (0107), dos dois lados.
 *
 * ## O provedor — só o dono
 *
 * `GET/POST/DELETE /api/tenant/subscription/cancellation`,
 * `POST .../cancellation/accept` e `POST .../cancellation/confirm`, com
 * `settings.write` na rota e o PAPEL conferido aqui: cancelar o contrato é
 * decisão de quem é dono da conta — o `owner`, ou o `admin` de um provedor
 * que não tem dono (a regra de `TenantController.updateSecurity`). Um admin
 * contratado não cancela a empresa. A leitura (`GET`) também é só do dono:
 * as ofertas são uma negociação com ele.
 *
 * Cada passo que muda alguma coisa grava as duas trilhas: a do provedor (quem
 * pediu) e a da plataforma (`SUBSCRIPTION_CANCELLATION_CHANGED`, com
 * `selfService: true`) — é nela que o console reconstrói por que um cliente
 * saiu ou ficou.
 *
 * ## O console
 *
 * `GET /api/platform/reports/cancellations` (o relatório) e
 * `DELETE /api/platform/tenants/:id/subscription/cancellation` (desfazer o
 * cancelamento agendado de um provedor).
 */

async function eDono(tenantId, role) {
  const papel = normalizeRole(role);
  if (papel === 'owner') return true;
  if (papel !== 'admin') return false;
  return (await TenantUser.countByRole(tenantId, 'owner')) === 0;
}

function recusa(req, res, error) {
  return res.status(error.status || 400).json({
    ...createErrorResponse(translateError(req.t, error), error.detail ?? null, error.code),
    ...(error.extra ?? {})
  });
}

async function soDono(req, res) {
  if (await eDono(req.tenantId, req.user?.role)) return true;
  res.status(403).json(createErrorResponse(req.t('cancellation.ownerOnly'), null, 'owner_only'));
  return false;
}

/** As duas trilhas de um passo do provedor. */
async function trilhas(req, detail) {
  const completo = { ...detail, selfService: true };
  await AuditLog.fromRequest(req, {
    action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
    subjectType: 'subscription',
    subjectId: req.tenantId,
    detail: completo
  });
  const provedor = await Tenant.findById(req.tenantId);
  const registrada = await PlatformAudit.fromRequest(req, {
    action: PlatformAudit.ACTIONS.SUBSCRIPTION_CANCELLATION_CHANGED,
    tenant: provedor,
    detail: completo
  });
  if (!registrada) console.warn(`Provider ${req.tenantId} cancellation step without a platform trail line`);
}

/** A assinatura como a tela de Plano a lê, depois do passo. */
async function assinaturaDepois() {
  return SubscriptionService.present(await SubscriptionService.current());
}

class CancellationController {
  /** `GET /api/tenant/subscription/cancellation` — os motivos, as ofertas e o que está pendente. */
  static async status(req, res) {
    try {
      if (!(await soDono(req, res))) return undefined;
      return res.json(createResponse(req.t('cancellation.retrieved'), await CancellationService.status()));
    } catch (error) {
      console.error('Cancellation status error:', error);
      return res.status(500).json(createErrorResponse(req.t('cancellation.failed'), error.message));
    }
  }

  /** `POST /api/tenant/subscription/cancellation` — `{ reason, comment? }`: devolve as ofertas. */
  static async request(req, res) {
    try {
      if (!(await soDono(req, res))) return undefined;
      const resultado = await CancellationService.request({
        reason: req.body?.reason,
        comment: req.body?.comment ?? null,
        actorUserId: req.user?.userId ?? null
      });
      await trilhas(req, {
        cancellation: 'requested',
        reason: resultado.request.reason,
        requestId: resultado.request.id,
        offersPresented: resultado.request.offersPresented
      });
      return res.status(201).json(createResponse(req.t('cancellation.requested'), resultado));
    } catch (error) {
      if (error instanceof SelfBillingError) return recusa(req, res, error);
      console.error('Cancellation request error:', error);
      return res.status(500).json(createErrorResponse(req.t('cancellation.failed'), error.message));
    }
  }

  /** `POST /api/tenant/subscription/cancellation/accept` — `{ offer: 'discount'|'pause', months? }`. */
  static async accept(req, res) {
    try {
      if (!(await soDono(req, res))) return undefined;
      const resultado = await CancellationService.accept({
        offer: req.body?.offer,
        months: req.body?.months ?? null,
        actorUserId: req.user?.userId ?? null,
        countDevices: () => DeviceService.countDevicesFromGenieAcs()
      });
      await trilhas(req, {
        cancellation: resultado.offer === 'discount' ? 'retained_discount' : 'retained_pause',
        requestId: resultado.request?.id ?? null,
        ...(resultado.coupon ? { coupon: resultado.coupon, priceCents: resultado.priceCents } : {}),
        ...(resultado.replacedCouponId ? { replacedCouponId: resultado.replacedCouponId } : {}),
        ...(resultado.pausedUntil ? { pausedFrom: resultado.pausedFrom, pausedUntil: resultado.pausedUntil, months: resultado.months } : {})
      });
      const chave = resultado.offer === 'discount' ? 'cancellation.discountAccepted' : 'cancellation.pauseAccepted';
      return res.json(createResponse(req.t(chave), { ...resultado, subscription: await assinaturaDepois() }));
    } catch (error) {
      if (error instanceof SelfBillingError) return recusa(req, res, error);
      console.error('Cancellation accept error:', error);
      return res.status(500).json(createErrorResponse(req.t('cancellation.failed'), error.message));
    }
  }

  /** `POST /api/tenant/subscription/cancellation/confirm` — recusa as ofertas e cancela no fim do período. */
  static async confirm(req, res) {
    try {
      if (!(await soDono(req, res))) return undefined;
      const resultado = await CancellationService.confirm({ actorUserId: req.user?.userId ?? null });
      await trilhas(req, {
        cancellation: resultado.immediate ? 'canceled' : 'scheduled',
        cancelAt: resultado.cancelAt,
        requestId: resultado.request?.id ?? null,
        reason: resultado.request?.reason ?? null,
        ...(resultado.canceledCharges ? { canceledCharges: resultado.canceledCharges } : {})
      });
      const chave = resultado.immediate ? 'cancellation.canceledNow' : 'cancellation.scheduled';
      return res.json(createResponse(req.t(chave), { ...resultado, subscription: await assinaturaDepois() }));
    } catch (error) {
      if (error instanceof SelfBillingError) return recusa(req, res, error);
      console.error('Cancellation confirm error:', error);
      return res.status(500).json(createErrorResponse(req.t('cancellation.failed'), error.message));
    }
  }

  /** `DELETE /api/tenant/subscription/cancellation` — desfaz o cancelamento agendado. */
  static async revert(req, res) {
    try {
      if (!(await soDono(req, res))) return undefined;
      const resultado = await CancellationService.revert({ source: 'provider', actorUserId: req.user?.userId ?? null });
      await trilhas(req, { cancellation: 'reverted', cancelAt: resultado.cancelAt, reopenedCharge: resultado.reopenedCharge });
      return res.json(createResponse(req.t('cancellation.reverted'), { ...resultado, subscription: await assinaturaDepois() }));
    } catch (error) {
      if (error instanceof SelfBillingError) return recusa(req, res, error);
      console.error('Cancellation revert error:', error);
      return res.status(500).json(createErrorResponse(req.t('cancellation.failed'), error.message));
    }
  }

  // ── O console ────────────────────────────────────────────────────────

  /** `GET /api/platform/reports/cancellations?from=YYYY-MM-DD` — o relatório. */
  static async report(req, res) {
    try {
      const bruto = req.query?.from;
      let since = null;
      if (bruto !== undefined && bruto !== '') {
        if (typeof bruto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(bruto) || Number.isNaN(Date.parse(`${bruto}T00:00:00Z`))) {
          return res.status(400).json(createErrorResponse('from must be a date (YYYY-MM-DD)', null, 'invalid_from'));
        }
        since = new Date(`${bruto}T00:00:00Z`);
      }
      return res.json(createResponse('Cancellation report retrieved', await CancellationService.report({ since })));
    } catch (error) {
      console.error('Cancellation report error:', error);
      return res.status(500).json(createErrorResponse('Failed to build the cancellation report', error.message));
    }
  }

  /** `DELETE /api/platform/tenants/:id/subscription/cancellation` — o console desfaz o agendado. */
  static async consoleRevert(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json(createErrorResponse('Invalid provider id'));
      const tenant = await Tenant.findById(id);
      if (!tenant || tenant.kind === 'platform') return res.status(404).json(createErrorResponse('Provider not found'));
      let resultado;
      try {
        resultado = await runInTenant(tenant.id, () => CancellationService.revert({
          source: 'console', actorUserId: req.user?.userId ?? null
        }));
      } catch (error) {
        if (error instanceof SelfBillingError) {
          return res.status(error.status || 409).json(createErrorResponse('No scheduled cancellation to revert', null, error.code));
        }
        throw error;
      }
      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_CANCELLATION_CHANGED,
        detail: { cancellation: 'reverted', source: 'console', cancelAt: resultado.cancelAt, reopenedCharge: resultado.reopenedCharge }
      });
      return res.json(createResponse('Scheduled cancellation reverted', {
        ...resultado,
        subscription: await subscriptionView(tenant)
      }));
    } catch (error) {
      console.error('Console cancellation revert error:', error);
      return res.status(500).json(createErrorResponse('Failed to revert the scheduled cancellation', error.message));
    }
  }
}

export default CancellationController;

import Tenant from '../models/Tenant.js';
import PlatformAudit from '../models/PlatformAudit.js';
import ReferralService from '../services/referralService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { recordBoth } from './platformBillingController.js';

/**
 * A indicação e os créditos de UM provedor, vistos do console (0106).
 *
 * O `:id` é de provedor visto de cima, como o resto de `/tenants/:id/…`; a
 * caixa da plataforma responde 404 como um id que não existe. Os créditos são
 * lidos e escritos NO ESCOPO do provedor da URL (`ReferralService`), então o
 * crédito de um nunca aparece — nem é abatido — na conta do outro.
 */

/** O maior ajuste manual de uma vez: R$ 10.000,00, para cada lado. */
const AJUSTE_MAXIMO = 1_000_000;

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

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

class PlatformReferralsController {
  /**
   * `GET /api/platform/tenants/:id/referrals` — o código, quem o indicou, quem
   * ele indicou (com o nome inteiro e o estado de cada recompensa), o saldo,
   * os créditos e as alocações em cobranças.
   */
  static async get(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      return res.json(createResponse('Referrals retrieved', await ReferralService.presentForConsole(tenant.id)));
    } catch (error) {
      console.error('Get referrals (console) error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the referrals', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/credits` — `{ amountCents, reason }`: o
   * ajuste manual do saldo. Positivo dá crédito; negativo tira do saldo livre
   * (409 `insufficient_credit`, com `balanceCents`, quando passa dele). O
   * motivo é obrigatório e vai às duas trilhas (`recordBoth`).
   *
   * 400 `invalid_amount` (zero, não inteiro, ou acima de R$ 10.000,00) e
   * `reason_required`.
   */
  static async adjust(req, res) {
    try {
      const body = req.body ?? {};
      const amount = Number(body.amountCents);
      if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > AJUSTE_MAXIMO) {
        return res.status(400).json(
          createErrorResponse('amountCents must be a non-zero integer up to 1000000', null, 'invalid_amount')
        );
      }
      const reason = String(body.reason ?? '').trim().slice(0, 255);
      if (!reason) return res.status(400).json(createErrorResponse('A reason is required', null, 'reason_required'));
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;

      let resultado;
      try {
        resultado = await ReferralService.adjust({
          tenantId: tenant.id, amountCents: amount, reason, actorUserId: req.user?.id ?? null
        });
      } catch (error) {
        if (error.code === 'insufficient_credit') {
          return res.status(409).json({
            ...createErrorResponse(error.message, null, 'insufficient_credit'),
            balanceCents: error.balanceCents
          });
        }
        if (error.code === 'busy') return res.status(409).json(createErrorResponse(error.message, null, 'busy'));
        throw error;
      }

      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.TENANT_CREDIT_ADJUSTED,
        detail: {
          creditId: resultado.creditId,
          amountCents: resultado.amountCents,
          reason,
          balanceBefore: resultado.balanceBefore,
          balanceAfter: resultado.balanceAfter
        }
      });
      return res.status(201).json(createResponse('Credit adjusted', {
        ...resultado,
        referrals: await ReferralService.presentForConsole(tenant.id)
      }));
    } catch (error) {
      console.error('Adjust credit error:', error);
      return res.status(500).json(createErrorResponse('Failed to adjust the credit', error.message));
    }
  }
}

export default PlatformReferralsController;

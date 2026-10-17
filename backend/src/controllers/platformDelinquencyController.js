import Tenant from '../models/Tenant.js';
import DelinquencyService, {
  DELINQUENCY_ACTIONS, DELINQUENCY_BUCKETS, MAX_BULK_TENANTS, MAX_EXTEND_DAYS
} from '../services/delinquencyService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { recordBoth } from './platformBillingController.js';

/**
 * O painel de inadimplência do console (ver `DelinquencyService`): a lista
 * de quem deve, e as ações em massa sobre ela.
 *
 * Nenhuma das duas rotas leva id na URL: a lista é de todos, e as ações
 * levam os provedores no corpo — cada um é lido, conferido e tratado no
 * escopo DELE (`runInTenant`, dentro do serviço), com resultado e trilha
 * próprios. Um provedor que falha não para os outros, e o pedido inteiro
 * responde 200 com o resultado de cada um.
 */

const STATUS_FILTERS = new Set(['past_due', 'suspended', 'active', 'trial', 'auto_suspended', 'manual_suspended']);

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

class PlatformDelinquencyController {
  /**
   * `GET /api/platform/delinquency?bucket=&status=&q=&sort=amount|days&order=asc|desc`
   *
   * Responde `{ rows, summary }`; o resumo é sempre o de todos os
   * inadimplentes, e os filtros recortam só `rows`.
   */
  static async list(req, res) {
    try {
      const query = req.query ?? {};
      const bucket = String(query.bucket ?? '').trim();
      const status = String(query.status ?? '').trim();
      const sort = String(query.sort ?? '').trim();
      const order = String(query.order ?? '').trim();
      if (bucket && !DELINQUENCY_BUCKETS.includes(bucket)) {
        return res.status(400).json(createErrorResponse(`bucket must be one of: ${DELINQUENCY_BUCKETS.join(', ')}`, null, 'invalid_bucket'));
      }
      if (status && !STATUS_FILTERS.has(status)) {
        return res.status(400).json(createErrorResponse('Invalid status filter', null, 'invalid_status'));
      }
      if (sort && sort !== 'amount' && sort !== 'days') {
        return res.status(400).json(createErrorResponse('sort must be amount or days', null, 'invalid_sort'));
      }
      if (order && order !== 'asc' && order !== 'desc') {
        return res.status(400).json(createErrorResponse('order must be asc or desc', null, 'invalid_order'));
      }
      const { rows, summary } = await DelinquencyService.list();
      const visiveis = DelinquencyService.filter(rows, {
        bucket, status, q: String(query.q ?? '').slice(0, 100), sort, order
      });
      return res.json(createResponse('Delinquency retrieved', { rows: visiveis, summary }));
    } catch (error) {
      console.error('List delinquency error:', error);
      return res.status(500).json(createErrorResponse('Failed to list the delinquent providers', error.message));
    }
  }

  /**
   * `POST /api/platform/delinquency/actions` — `{ tenantIds, action, params }`.
   *
   *   remind   reenvia o lembrete com o link, no máximo um a cada 24 h
   *   suspend  suspende à mão (`reason` opcional)
   *   exempt   isenta de cobrança (`until` opcional, ISO no futuro)
   *   extend   dá `days` (1–60) dias de prazo; com `requestId` (8–64 letras,
   *            dígitos ou hífens), o mesmo pedido repetido não dá de novo
   *
   * Responde `{ action, results: [{ tenantId, ok, code, ...detail }], okCount, failedCount }`.
   */
  static async run(req, res) {
    try {
      const body = req.body ?? {};
      const action = body.action;
      if (!DELINQUENCY_ACTIONS.includes(action)) {
        return res.status(400).json(createErrorResponse(`action must be one of: ${DELINQUENCY_ACTIONS.join(', ')}`, null, 'invalid_action'));
      }
      if (!Array.isArray(body.tenantIds) || body.tenantIds.length === 0) {
        return res.status(400).json(createErrorResponse('tenantIds must be a non-empty list', null, 'invalid_tenant_ids'));
      }
      const ids = [...new Set(body.tenantIds.map(parseId))];
      if (ids.includes(null)) {
        return res.status(400).json(createErrorResponse('tenantIds must be positive integers', null, 'invalid_tenant_ids'));
      }
      if (ids.length > MAX_BULK_TENANTS) {
        return res.status(400).json(createErrorResponse(`At most ${MAX_BULK_TENANTS} providers per request`, null, 'too_many_tenants'));
      }

      const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
      if (params.reason !== undefined && params.reason !== null && typeof params.reason !== 'string') {
        return res.status(400).json(createErrorResponse('reason must be a string', null, 'invalid_reason'));
      }
      const reason = typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim().slice(0, 255) : null;
      const limpos = { reason };
      if (action === 'extend') {
        const days = Number(params.days);
        if (!Number.isInteger(days) || days < 1 || days > MAX_EXTEND_DAYS) {
          return res.status(400).json(createErrorResponse(`days must be an integer between 1 and ${MAX_EXTEND_DAYS}`, null, 'invalid_days'));
        }
        limpos.days = days;
      }
      if (params.requestId !== undefined && params.requestId !== null) {
        // A chave do pedido (a cortesia a usa para não dar o prazo duas vezes).
        if (typeof params.requestId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(params.requestId)) {
          return res.status(400).json(createErrorResponse('requestId must be 8 to 64 letters, digits or dashes', null, 'invalid_request_id'));
        }
        limpos.requestId = params.requestId;
      }
      if (action === 'exempt' && params.until !== undefined && params.until !== null && params.until !== '') {
        const ate = typeof params.until === 'string' ? new Date(params.until) : null;
        if (!ate || Number.isNaN(ate.getTime()) || ate.getTime() <= Date.now()) {
          return res.status(400).json(createErrorResponse('until must be a future ISO date-time', null, 'invalid_until'));
        }
        limpos.until = params.until;
      }

      const actorUserId = req.user?.userId ?? null;
      const results = [];
      // Um de cada vez, e não em paralelo: cada ação pode falar com o gateway
      // (o cancelamento das faturas na isenção, o vencimento que acompanha o
      // prazo), e duzentas chamadas de uma vez seriam a nossa conta na Asaas
      // tomando limite de taxa no meio do pedido.
      for (const tenantId of ids) {
        let resultado;
        try {
          // eslint-disable-next-line no-await-in-loop -- um provedor por vez, de propósito
          const tenant = await Tenant.findById(tenantId);
          if (!tenant || tenant.kind === 'platform') {
            resultado = { ok: false, code: 'not_found' };
          } else {
            // eslint-disable-next-line no-await-in-loop -- idem
            resultado = await DelinquencyService.runAction({ tenant, action, params: limpos, actorUserId });
            if (resultado.ok && resultado.audit) {
              // A ação já foi feita: a trilha que falha não pode virar "erro"
              // na resposta, ou a pessoa repetiria o que já aconteceu.
              try {
                // eslint-disable-next-line no-await-in-loop -- idem
                await recordBoth(req, tenant, resultado.audit);
              } catch (error) {
                console.error(`Delinquency audit failed for provider ${tenantId}:`, error);
              }
            }
          }
        } catch (error) {
          console.error(`Delinquency action ${action} failed for provider ${tenantId}:`, error);
          resultado = { ok: false, code: 'error' };
        }
        results.push({ tenantId, ok: resultado.ok, code: resultado.code, ...(resultado.detail ?? {}) });
      }
      const okCount = results.filter((r) => r.ok).length;
      return res.json(createResponse('Delinquency action applied', {
        action, results, okCount, failedCount: results.length - okCount
      }));
    } catch (error) {
      console.error('Delinquency action error:', error);
      return res.status(500).json(createErrorResponse('Failed to apply the action', error.message));
    }
  }
}

export default PlatformDelinquencyController;

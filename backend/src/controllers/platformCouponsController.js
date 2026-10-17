import Coupon, {
  COUPON_KINDS, COUPON_DURATIONS, normalizeCouponCode, parseCouponPlanIds
} from '../models/Coupon.js';
import Plan from '../models/Plan.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * A aba Cupons do console (0093): criar, listar com o uso, mudar o que pode
 * mudar e apagar.
 *
 * O que NÃO muda depois de criado: código, tipo, valor e duração. São o que o
 * extrato de quem já resgatou nomeia, e mudar o valor de um cupom em uso
 * mudaria o preço de quem já o tem sem ninguém aplicar nada — um cupom
 * diferente é um cupom novo. Mudam só as portas do RESGATE: `active`,
 * `validUntil` e `maxRedemptions`.
 *
 * Apagar só o que nunca foi resgatado; o resgatado é desativado no lugar —
 * as assinaturas que o têm continuam com o desconto, e o extrato delas
 * continua apontando para uma linha que existe.
 */

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
/** Um teto de bom senso para o desconto fixo: R$ 100.000,00. */
const FIXED_MAX_CENTS = 10_000_000;
/** E para a duração em ciclos: dez anos de mensalidade. */
const CYCLES_MAX = 120;

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Inteiro ≥ 1, nulo (vazio), ou erro. */
function parsePositiveOrNull(value, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) return { ok: false };
  return { ok: true, value: n };
}

/** Uma data ISO, nula (vazia), ou erro. */
function parseDateOrNull(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const data = new Date(String(value));
  if (Number.isNaN(data.getTime())) return { ok: false };
  // Ao segundo: o MySQL guarda ao segundo, e o que se devolve é o que se gravou.
  return { ok: true, value: new Date(Math.floor(data.getTime() / 1000) * 1000) };
}

function isoOf(value) {
  if (!value) return null;
  const data = value instanceof Date ? value : new Date(value);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

export function presentCoupon(cupom, inUse = 0) {
  return {
    id: Number(cupom.id),
    code: cupom.code,
    kind: cupom.kind,
    value: Number(cupom.value),
    duration: cupom.duration,
    durationCycles: cupom.duration_cycles === null || cupom.duration_cycles === undefined
      ? null : Number(cupom.duration_cycles),
    maxRedemptions: cupom.max_redemptions === null || cupom.max_redemptions === undefined
      ? null : Number(cupom.max_redemptions),
    redemptions: Number(cupom.redemptions ?? 0),
    validUntil: isoOf(cupom.valid_until),
    planIds: parseCouponPlanIds(cupom.plan_ids),
    active: Boolean(cupom.active),
    createdAt: isoOf(cupom.created_at),
    inUse: Number(inUse ?? 0)
  };
}

/** A lista de planos do corpo: nula (todos), ou ids que existem. */
async function parsePlanIds(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return { ok: false };
  const ids = [...new Set(value.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return { ok: false };
  const existentes = await Promise.all(ids.map((id) => Plan.findById(id)));
  if (existentes.some((plano) => !plano)) return { ok: false };
  return { ok: true, value: ids };
}

const recusa = (res, message, code = null, status = 400) => res.status(status).json(createErrorResponse(message, null, code));

class PlatformCouponsController {
  /** `GET /api/platform/coupons` — todos, com resgates e quantas assinaturas os usam agora. */
  static async list(req, res) {
    try {
      const [cupons, uso] = await Promise.all([Coupon.list(), Coupon.activeUsage()]);
      return res.json(createResponse('Coupons retrieved', {
        coupons: cupons.map((cupom) => presentCoupon(cupom, uso.get(Number(cupom.id)) ?? 0))
      }));
    } catch (error) {
      console.error('List coupons error:', error);
      return res.status(500).json(createErrorResponse('Failed to list coupons', error.message));
    }
  }

  /**
   * `POST /api/platform/coupons` — `{ code, kind, value, duration,
   * durationCycles?, maxRedemptions?, validUntil?, planIds?, active? }`.
   *
   * O de 100% é recusado: com o piso de R$ 5,00 ele não daria fatura zero,
   * mas prometeria uma — e quem o recebe espera não pagar nada.
   */
  static async create(req, res) {
    try {
      const body = req.body ?? {};
      const code = normalizeCouponCode(body.code);
      if (!CODE_PATTERN.test(code)) {
        return recusa(res, 'Coupon code must be 2 to 32 letters, digits, hyphens or underscores');
      }
      if (!COUPON_KINDS.includes(body.kind)) return recusa(res, `kind must be one of: ${COUPON_KINDS.join(', ')}`);
      const valor = Number(body.value);
      if (body.kind === 'percent') {
        if (Number.isInteger(valor) && valor >= 100) {
          return recusa(res, 'A 100% coupon is not allowed: every invoice has to charge something', 'coupon_full_discount');
        }
        if (!Number.isInteger(valor) || valor < 1) return recusa(res, 'A percent coupon value must be an integer from 1 to 99');
      } else if (!Number.isInteger(valor) || valor < 1 || valor > FIXED_MAX_CENTS) {
        return recusa(res, 'A fixed coupon value must be a positive integer of cents');
      }
      if (!COUPON_DURATIONS.includes(body.duration)) {
        return recusa(res, `duration must be one of: ${COUPON_DURATIONS.join(', ')}`);
      }
      let ciclos = null;
      if (body.duration === 'repeating') {
        const lido = parsePositiveOrNull(body.durationCycles, CYCLES_MAX);
        if (!lido.ok || lido.value === null) {
          return recusa(res, `durationCycles must be an integer from 1 to ${CYCLES_MAX} for a repeating coupon`);
        }
        ciclos = lido.value;
      }
      const teto = parsePositiveOrNull(body.maxRedemptions);
      if (!teto.ok) return recusa(res, 'maxRedemptions must be a positive integer or null');
      const validade = parseDateOrNull(body.validUntil);
      if (!validade.ok) return recusa(res, 'validUntil must be a date or null');
      if (validade.value && validade.value.getTime() <= Date.now()) {
        return recusa(res, 'validUntil must be in the future');
      }
      const planos = await parsePlanIds(body.planIds);
      if (!planos.ok) return recusa(res, 'planIds must be a non-empty list of existing plan ids, or null');

      if (await Coupon.findByCode(code)) return recusa(res, 'Coupon code already taken', 'coupon_code_taken', 409);
      const cupom = await Coupon.create({
        code,
        kind: body.kind,
        value: valor,
        duration: body.duration,
        duration_cycles: ciclos,
        max_redemptions: teto.value,
        redemptions: 0,
        valid_until: validade.value,
        plan_ids: planos.value ? JSON.stringify(planos.value) : null,
        active: body.active === undefined ? true : Boolean(body.active)
      });
      const apresentado = presentCoupon(cupom);
      await PlatformAudit.fromRequest(req, { action: PlatformAudit.ACTIONS.COUPON_CREATED, detail: apresentado });
      return res.status(201).json(createResponse('Coupon created', { coupon: apresentado }));
    } catch (error) {
      console.error('Create coupon error:', error);
      return res.status(500).json(createErrorResponse('Failed to create the coupon', error.message));
    }
  }

  /** `PATCH /api/platform/coupons/:id` — só `active`, `validUntil` e `maxRedemptions`. */
  static async update(req, res) {
    try {
      const id = parseId(req.params?.id);
      if (!id) return recusa(res, 'Invalid coupon id');
      const cupom = await Coupon.findById(id);
      if (!cupom) return recusa(res, 'Coupon not found', null, 404);

      const body = req.body ?? {};
      const imutaveis = ['code', 'kind', 'value', 'duration', 'durationCycles', 'planIds'].filter((k) => body[k] !== undefined);
      if (imutaveis.length) {
        return recusa(res, `These fields cannot change after creation: ${imutaveis.join(', ')}`, 'coupon_immutable');
      }
      const patch = {};
      if (body.active !== undefined) {
        if (typeof body.active !== 'boolean') return recusa(res, 'active must be true or false');
        patch.active = body.active;
      }
      if (body.validUntil !== undefined) {
        const validade = parseDateOrNull(body.validUntil);
        if (!validade.ok) return recusa(res, 'validUntil must be a date or null');
        patch.valid_until = validade.value;
      }
      if (body.maxRedemptions !== undefined) {
        const teto = parsePositiveOrNull(body.maxRedemptions);
        if (!teto.ok) return recusa(res, 'maxRedemptions must be a positive integer or null');
        patch.max_redemptions = teto.value;
      }
      if (!Object.keys(patch).length) return recusa(res, 'Nothing to update');

      const uso = await Coupon.activeUsage();
      const depois = await Coupon.update(id, patch);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.COUPON_UPDATED,
        detail: { id, before: presentCoupon(cupom), after: presentCoupon(depois) }
      });
      return res.json(createResponse('Coupon updated', { coupon: presentCoupon(depois, uso.get(id) ?? 0) }));
    } catch (error) {
      console.error('Update coupon error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the coupon', error.message));
    }
  }

  /**
   * `DELETE /api/platform/coupons/:id` — apaga o nunca resgatado; o resgatado
   * é desativado (`deleted: false, deactivated: true`).
   */
  static async remove(req, res) {
    try {
      const id = parseId(req.params?.id);
      if (!id) return recusa(res, 'Invalid coupon id');
      const cupom = await Coupon.findById(id);
      if (!cupom) return recusa(res, 'Coupon not found', null, 404);

      // Condicional: um resgate que entrou depois da leitura faz a exclusão
      // não casar, e o cupom é desativado em vez de sumir.
      const apagou = Number(cupom.redemptions ?? 0) === 0 && await Coupon.deleteIfUnused(id);
      if (!apagou) await Coupon.update(id, { active: false });
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.COUPON_DELETED,
        detail: { ...presentCoupon(cupom), deleted: apagou, deactivated: !apagou }
      });
      const depois = apagou ? null : await Coupon.findById(id);
      return res.json(createResponse(apagou ? 'Coupon deleted' : 'Coupon deactivated', {
        deleted: apagou,
        deactivated: !apagou,
        coupon: depois ? presentCoupon(depois, (await Coupon.activeUsage()).get(id) ?? 0) : null
      }));
    } catch (error) {
      console.error('Delete coupon error:', error);
      return res.status(500).json(createErrorResponse('Failed to delete the coupon', error.message));
    }
  }
}

export default PlatformCouponsController;

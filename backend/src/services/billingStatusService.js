import SgpService from './sgpService.js';
import { isUniqueViolation, tdb, tinsert } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';
import { situacaoFinanceira, situacaoPorVencimento } from '../utils/wa/waCobranca.js';

/** Quanto a foto vale antes de ser consultada de novo. */
export const BILLING_STATUS_TTL_MS = 6 * 3600_000;
/** Quantos contratos uma leitura da lista manda atualizar, no máximo. */
const REFRESH_PER_CALL = 10;

/**
 * A situação financeira de cada contrato — em dia, vence hoje, atrasado —
 * para colorir a caixa de entrada sem consultar o SGP a cada conversa.
 *
 * A foto guarda só a data da fatura em aberto mais antiga, gravada sempre que
 * o painel já consulta o SGP por outro motivo (o Módulo SGP aberto, a régua,
 * o bot). A cor é calculada na leitura, com a data de hoje: a que vence hoje
 * fica vermelha amanhã sem nova consulta. Foto velha é atualizada em segundo
 * plano, poucas por vez, no ritmo de `WaBillingService`.
 */
class BillingStatusService {
  static refreshing = new Set();

  /** Grava a foto a partir das faturas em aberto. Nunca lança. */
  static async record(contract, invoices, now = new Date()) {
    const key = String(contract ?? '').trim();
    if (!key || !Array.isArray(invoices)) return null;
    try {
      const { oldestDueDate } = situacaoFinanceira(invoices, now);
      const atualizou = await tdb('sgp_billing_status').where({ contract: key })
        .update({ oldest_due_date: oldestDueDate, checked_at: now });
      if (!atualizou) {
        try {
          await tinsert('sgp_billing_status', { contract: key, oldest_due_date: oldestDueDate, checked_at: now });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          await tdb('sgp_billing_status').where({ contract: key }).update({ oldest_due_date: oldestDueDate, checked_at: now });
        }
      }
      return oldestDueDate;
    } catch (error) {
      console.warn(`[billing-status] contrato ${key}: ${error.message}`);
      return null;
    }
  }

  /** A situação pública de uma foto, com a cor do dia de hoje. */
  static publicStatus(row, now = new Date()) {
    if (!row) return null;
    const { status, daysOverdue } = situacaoPorVencimento(row.oldest_due_date, now);
    return {
      status,
      daysOverdue,
      oldestDueDate: row.oldest_due_date || null,
      checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : null
    };
  }

  /** `Map<contrato, situação>` dos contratos que têm foto. */
  static async forContracts(contracts, now = new Date()) {
    const keys = [...new Set((contracts || []).map((c) => String(c ?? '').trim()).filter(Boolean))];
    const mapa = new Map();
    if (!keys.length) return mapa;
    const rows = await tdb('sgp_billing_status').whereIn('contract', keys).select('contract', 'oldest_due_date', 'checked_at');
    for (const row of rows) mapa.set(String(row.contract), this.publicStatus(row, now));
    return mapa;
  }

  /**
   * Manda atualizar, em segundo plano, os contratos sem foto ou com foto
   * velha. Não espera: a lista responde já, e a cor chega na próxima leitura.
   * Um provedor de cada vez — duas leituras seguidas não empilham consultas.
   */
  static refreshStale(contracts, current, { now = new Date(), max = REFRESH_PER_CALL } = {}) {
    const tenant = currentTenantId();
    if (this.refreshing.has(tenant)) return null;
    const velhos = [...new Set((contracts || []).map((c) => String(c ?? '').trim()).filter(Boolean))]
      .filter((c) => {
        const foto = current.get(c);
        return !foto?.checkedAt || now.getTime() - new Date(foto.checkedAt).getTime() > BILLING_STATUS_TTL_MS;
      })
      .slice(0, max);
    if (!velhos.length) return null;
    this.refreshing.add(tenant);
    const tarefa = (async () => {
      try {
        if (!SgpService.isReady(await SgpService.getConfig())) return;
        // Importado aqui: `WaBillingService` grava a foto por este serviço.
        const { default: WaBillingService } = await import('./waBillingService.js');
        let calls = 0;
        for (const contract of velhos) {
          // eslint-disable-next-line no-await-in-loop -- no ritmo do SGP, um contrato por vez
          await WaBillingService.pacedInvoices(contract, calls++ > 0);
        }
      } catch (error) {
        console.warn(`[billing-status] atualização: ${error.message}`);
      } finally {
        this.refreshing.delete(tenant);
      }
    })();
    return tarefa;
  }
}

export default BillingStatusService;

import { createResponse, createErrorResponse } from '../utils/helpers.js';
import {
  RevenueRangeError, buildRevenueCsv, buildRevenueReport, parseRange
} from '../services/revenueReportService.js';

/**
 * Os relatórios do console. Só leitura: nenhum gesto aqui mexe em cobrança ou
 * assinatura, e por isso nenhum vai para a trilha — o que eles mostram já
 * está nela, gesto por gesto.
 */

/** O período recusado (400, com o código que a tela traduz), ou o período. */
function periodoOuRecusa(req, res) {
  try {
    return { range: parseRange(req.query) };
  } catch (error) {
    if (error instanceof RevenueRangeError) {
      res.status(error.status).json(createErrorResponse(error.message, null, error.code));
      return { recusado: true };
    }
    throw error;
  }
}

class PlatformReportsController {
  /** `GET /api/platform/reports/revenue?from&to` — ver `revenueReportService`. */
  static async revenue(req, res) {
    try {
      const { range, recusado } = periodoOuRecusa(req, res);
      if (recusado) return undefined;
      return res.json(createResponse('Revenue report retrieved', await buildRevenueReport(range)));
    } catch (error) {
      console.error('Revenue report error:', error);
      return res.status(500).json(createErrorResponse('Failed to build the revenue report', error.message));
    }
  }

  /** `GET /api/platform/reports/revenue.csv?from&to` — as cobranças do período. */
  static async revenueCsv(req, res) {
    try {
      const { range, recusado } = periodoOuRecusa(req, res);
      if (recusado) return undefined;
      const { csv } = await buildRevenueCsv(range);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="receita-${range.from}-a-${range.to}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(csv);
    } catch (error) {
      console.error('Revenue CSV error:', error);
      return res.status(500).json(createErrorResponse('Failed to export the revenue report', error.message));
    }
  }
}

export default PlatformReportsController;

import MaintenanceService from '../services/maintenanceService.js';
import { createResponse } from '../utils/helpers.js';
import { handleError } from './whatsappController.js';

/**
 * Manutenção programada — ver `MaintenanceService`. O id da rota é conferido
 * contra o provedor em escopo pela própria consulta (`tdb`): um id de outro
 * provedor responde "não encontrado".
 */
class MaintenanceController {
  static async list(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.maintenance.listed'), { windows: await MaintenanceService.list() }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.maintenance.failed');
    }
  }

  static async nodes(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.maintenance.listed'), { nodes: await MaintenanceService.nodes() }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.maintenance.failed');
    }
  }

  static async preview(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.maintenance.listed'), await MaintenanceService.preview(req.query?.nodeId, {
        startsAt: req.query?.startsAt,
        endsAt: req.query?.endsAt
      })));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.maintenance.failed');
    }
  }

  static async get(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.maintenance.listed'), await MaintenanceService.get(Number(req.params.id))));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.maintenance.failed');
    }
  }

  static async create(req, res) {
    try {
      const janela = await MaintenanceService.create(req.body ?? {}, { userId: req.user?.userId ?? null, req });
      return res.status(201).json(createResponse(req.t('whatsapp.maintenance.saved'), janela));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.maintenance.failed');
    }
  }

  static async update(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.maintenance.saved'), await MaintenanceService.update(Number(req.params.id), req.body ?? {})));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.maintenance.failed');
    }
  }

  static async notify(req, res) {
    try {
      const resultado = await MaintenanceService.notify(Number(req.params.id), { userId: req.user?.userId ?? null, req });
      return res.json(createResponse(req.t('whatsapp.maintenance.notified', { count: resultado.sent }), {
        ...resultado,
        window: await MaintenanceService.get(Number(req.params.id))
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.maintenance.failed');
    }
  }

  static async cancel(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.maintenance.cancelledOk'),
        await MaintenanceService.cancel(Number(req.params.id), { userId: req.user?.userId ?? null, req })
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.maintenance.failed');
    }
  }

  static async conclude(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.maintenance.concluded'), await MaintenanceService.conclude(Number(req.params.id))));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.maintenance.failed');
    }
  }
}

export default MaintenanceController;

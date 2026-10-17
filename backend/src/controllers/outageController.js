import OutageIncidentService from '../services/outageIncidentService.js';
import { createResponse } from '../utils/helpers.js';
import { handleError } from './whatsappController.js';

/**
 * Os incidentes de queda em massa — ver `OutageIncidentService`. O id da rota
 * é conferido contra o provedor em escopo pela própria consulta (`tdb`): um id
 * de outro provedor responde "não encontrado".
 */
class OutageController {
  static async list(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.outage.listed'), {
        incidents: await OutageIncidentService.list({
          days: req.query?.days,
          status: req.query?.status,
          search: req.query?.search,
          notified: req.query?.notified
        })
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.outage.failed');
    }
  }

  static async get(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.outage.listed'), await OutageIncidentService.get(Number(req.params.id))));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.outage.failed');
    }
  }

  static async update(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.outage.saved'),
        await OutageIncidentService.setEta(Number(req.params.id), req.body?.eta)
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.outage.failed');
    }
  }

  static async notify(req, res) {
    try {
      const resultado = await OutageIncidentService.notify(Number(req.params.id), {
        eta: req.body?.eta,
        body: req.body?.body,
        userId: req.user?.userId ?? null,
        req
      });
      return res.json(createResponse(req.t('whatsapp.outage.notified', { count: resultado.sent }), {
        ...resultado,
        incident: await OutageIncidentService.get(Number(req.params.id))
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.outage.failed');
    }
  }

  static async resolve(req, res) {
    try {
      await OutageIncidentService.get(Number(req.params.id));
      await OutageIncidentService.resolver(Number(req.params.id));
      return res.json(createResponse(req.t('whatsapp.outage.resolved'), await OutageIncidentService.get(Number(req.params.id))));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.outage.failed');
    }
  }
}

export default OutageController;

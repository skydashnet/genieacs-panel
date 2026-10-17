import PlatformAudit from '../models/PlatformAudit.js';
import { PlatformProfileError, readProfile, saveProfile } from '../services/platformProfileService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import PlatformAlertService from '../services/platformAlertService.js';
import { ALERT_CHANNELS } from '../services/platformProfileService.js';

/**
 * Configurações do console: os dados da empresa que vende o SaaS, que a
 * página pública e os avisos da equipe usam. Ver `platformProfileService`.
 */
class PlatformSettingsController {
  static async getProfile(req, res) {
    try {
      return res.json(createResponse('Profile retrieved', await readProfile()));
    } catch (error) {
      console.error('Read platform profile error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the profile', error.message));
    }
  }

  static async updateProfile(req, res) {
    try {
      const changed = await saveProfile(req.body ?? {});
      if (changed.length) {
        await PlatformAudit.fromRequest(req, {
          action: PlatformAudit.ACTIONS.PLATFORM_PROFILE_CHANGED,
          detail: { fields: changed }
        });
      }
      return res.json(createResponse('Profile saved', { ...(await readProfile()), changed }));
    } catch (error) {
      if (error instanceof PlatformProfileError) {
        return res.status(error.status).json({ ...createErrorResponse(error.message), field: error.field });
      }
      console.error('Save platform profile error:', error);
      return res.status(500).json(createErrorResponse('Failed to save the profile', error.message));
    }
  }

  /**
   * `POST /api/platform/alerts/test` — manda um alerta de teste AGORA, pelos
   * `channels` pedidos (os dois, sem pedido), fora do resumo diário. 200 com o
   * resultado por canal (`true` saiu, `false` falhou, `null` sem destino);
   * 409 `no_destination` quando nenhum canal pedido tem destino configurado;
   * 502 `send_failed` quando todos os canais com destino falharam.
   */
  static async testAlert(req, res) {
    try {
      const pedidos = req.body?.channels;
      if (pedidos !== undefined && (!Array.isArray(pedidos) || pedidos.some((c) => !ALERT_CHANNELS.includes(c)))) {
        return res.status(400).json({ ...createErrorResponse('Invalid channels'), code: 'invalid_channels' });
      }
      const resultado = await PlatformAlertService.sendTest({ channels: pedidos ?? null });
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_ALERT_TEST,
        detail: { status: resultado.status, channels: resultado.channels ?? {} }
      });
      if (resultado.reason === 'no_destination') {
        return res.status(409).json({
          ...createErrorResponse('No WhatsApp or email to send the alert to'), code: 'no_destination'
        });
      }
      if (resultado.status !== 'sent') {
        return res.status(502).json({
          ...createErrorResponse('The test alert could not be sent'), code: 'send_failed', channels: resultado.channels ?? {}
        });
      }
      return res.json(createResponse('Test alert sent', { channels: resultado.channels }));
    } catch (error) {
      console.error('Platform alert test error:', error);
      return res.status(500).json(createErrorResponse('Failed to send the test alert', error.message));
    }
  }
}

export default PlatformSettingsController;

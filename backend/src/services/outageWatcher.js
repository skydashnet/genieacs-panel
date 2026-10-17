import MappingNode from '../models/MappingNode.js';
import { forEachTenant } from '../config/tenantJobs.js';
import MapStatusService from './mapStatusService.js';

/**
 * Mantém o histórico de rompimentos em dia mesmo sem ninguém olhando o mapa
 * e com os alertas de WhatsApp desligados.
 *
 * A cada poucos minutos, para cada provedor que tem cliente com PPPoE no
 * mapa, pede o estado ao vivo — o mesmo de `GET /api/mapping-data/status`,
 * que já grava o histórico (`OutageEvent.observe`). Provedor sem cliente no
 * mapa não custa uma consulta ao GenieACS.
 */
const TICK_MS = 5 * 60 * 1000;

class OutageWatcher {
  static timer = null;

  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.warn(`Outage watcher tick failed: ${error.message}`);
      });
    }, TICK_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  static async tick() {
    await forEachTenant(async () => {
      const mapped = (await MappingNode.getAll()).some((node) => node.type === 'ont' && String(node.pppoe ?? '').trim());
      if (!mapped) return null;
      return MapStatusService.status();
    }, {
      onError: (error, tenant) => {
        console.warn(`Outage watcher skipped provider ${tenant.slug}: ${error.message}`);
      }
    });
  }
}

export default OutageWatcher;

import DeviceService from './deviceService.js';
import MappingNode from '../models/MappingNode.js';
import MappingEdge from '../models/MappingEdge.js';
import WaAlertService, { DEFAULT_RULES } from './waAlertService.js';
import { detectOutages } from './outageDetector.js';
import OutageEvent from '../models/OutageEvent.js';
import MaintenanceService from './maintenanceService.js';
import { currentTenantId } from '../config/tenantContext.js';

/**
 * O estado ao vivo dos pontos da Topologia que têm PPPoE cadastrado: o login
 * é o elo entre o ponto desenhado no mapa e o equipamento no GenieACS.
 *
 * - `online`: informou nos últimos minutos (a mesma janela da lista de
 *   equipamentos) e o sinal está bom;
 * - `weak`: online, mas com RX abaixo de `WEAK_RX_DBM` — o mesmo limite do
 *   painel e do alerta de WhatsApp;
 * - `offline`: o equipamento existe e parou de informar;
 * - `unknown`: nenhum equipamento no ACS com esse login.
 *
 * A frota é lida inteira numa consulta; o resultado fica alguns segundos em
 * memória por provedor, para que várias telas abertas no mapa não virem uma
 * consulta cada a cada recarga.
 */
export const WEAK_RX_DBM = -27;
const cache = new Map();

const normalize = (value) => String(value ?? '').trim().toLowerCase();

export function classifyNode(device) {
  if (!device) return 'unknown';
  if (!device.online) return 'offline';
  if (device.rxPower !== null && device.rxPower < WEAK_RX_DBM) return 'weak';
  return 'online';
}

class MapStatusService {
  static CACHE_MS = 30_000;

  static clearCache() {
    cache.clear();
  }

  static async fleet() {
    const key = currentTenantId() ?? 'default';
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.devices;
    const devices = await DeviceService.getMapStatusFleet();
    cache.set(key, { devices, expiresAt: Date.now() + this.CACHE_MS });
    return devices;
  }

  /** O limite da regra de queda em massa, para o mapa usar o mesmo do alerta. */
  static async outageThreshold() {
    try {
      return (await WaAlertService.getSettings()).rules.mass_outage.threshold;
    } catch {
      return DEFAULT_RULES.mass_outage.threshold;
    }
  }

  /**
   * Os equipamentos do ACS que ainda não têm ponto no mapa (pelo PPPoE):
   * é a lista de "colocar no mapa". Sem PPPoE não há como ligar ao ponto,
   * então esses ficam de fora.
   */
  static async unmapped({ limit = 1000 } = {}) {
    const mapped = new Set((await MappingNode.getAll()).map((node) => normalize(node.pppoe)).filter(Boolean));
    const seen = new Set();
    const devices = [];
    for (const device of await this.fleet()) {
      const login = normalize(device.pppoe);
      if (!login || mapped.has(login) || seen.has(login)) continue;
      seen.add(login);
      devices.push(device);
    }
    devices.sort((a, b) => String(a.pppoe).localeCompare(String(b.pppoe)));
    return { total: devices.length, items: devices.slice(0, limit) };
  }

  static async status() {
    const allNodes = await MappingNode.getAll();
    const nodes = allNodes.filter((node) => normalize(node.pppoe));
    const summary = { online: 0, weak: 0, offline: 0, unknown: 0 };
    if (!nodes.length) {
      // Sem cliente no mapa não há rompimento; o que estava aberto fecha.
      await OutageEvent.observe([]).catch(() => {});
      return { generatedAt: new Date().toISOString(), items: [], summary, outages: [] };
    }

    const byPppoe = new Map();
    for (const device of await this.fleet()) {
      const login = normalize(device.pppoe);
      if (!login) continue;
      // Dois equipamentos com o mesmo login (troca de ONT, o antigo na
      // gaveta): vale o que informou por último.
      const current = byPppoe.get(login);
      if (!current || String(device.lastInform ?? '') > String(current.lastInform ?? '')) byPppoe.set(login, device);
    }

    const items = nodes.map((node) => {
      const device = byPppoe.get(normalize(node.pppoe)) ?? null;
      const state = classifyNode(device);
      summary[state] += 1;
      return {
        node_id: node.node_id,
        state,
        deviceId: device?.deviceId ?? null,
        rxPower: device?.rxPower ?? null,
        lastInform: device?.lastInform ?? null
      };
    });
    // Provável rompimento: as caixas com vários clientes offline ao mesmo
    // tempo, pela mesma regra do alerta de WhatsApp (`outageDetector`).
    // Manutenção programada em andamento não é rompimento: as ONTs embaixo
    // do nó ficam fora da conta, como no alerta — o mapa e a mensagem não
    // podem discordar.
    let emManutencao = new Set();
    try {
      emManutencao = (await MaintenanceService.activeScope()).ontNodeIds;
    } catch (error) {
      console.warn(`Map status: maintenance scope unavailable: ${error.message}`);
    }
    for (const item of items) if (emManutencao.has(item.node_id)) item.maintenance = true;
    const offline = new Map(items
      .filter((item) => item.state === 'offline' && !item.maintenance)
      .map((item) => [item.node_id, item.lastInform ? new Date(item.lastInform).getTime() : null]));
    const outages = offline.size < 2
      ? []
      : detectOutages({ nodes: allNodes, edges: await MappingEdge.getAll(), offline, threshold: await this.outageThreshold() })
        .map((outage) => ({
          node_id: outage.box.node_id,
          name: outage.box.name,
          count: outage.count,
          total: outage.total,
          since: outage.since === null ? null : new Date(outage.since).toISOString(),
          clients: outage.clients
        }));
    // O histórico: esta é a foto completa do provedor, então pode abrir e
    // fechar ocorrências. Falhar aqui não pode esconder o estado da tela.
    await OutageEvent.observe(outages).catch((error) => {
      console.warn(`Outage history not recorded: ${error.message}`);
    });
    return { generatedAt: new Date().toISOString(), items, summary, outages };
  }
}

export default MapStatusService;

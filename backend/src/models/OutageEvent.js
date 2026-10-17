import { tdb, tinsertReturningId } from '../config/database.js';
import { timestampMs } from '../utils/helpers.js';

/**
 * O histórico de rompimentos por caixa — ver `outageEventsTable`.
 */
class OutageEvent {
  static async listOpen() {
    return tdb('outage_events').whereNull('ended_at').orderBy('id');
  }

  /**
   * Casa o que está caído agora com o que está aberto: caixa nova abre uma
   * linha, caixa que continua atualiza o pico, caixa que voltou fecha.
   *
   * `outages` precisa ser a foto COMPLETA do provedor — quem só sabe de parte
   * da rede não pode chamar isto, ou fecharia as outras.
   */
  static async observe(outages, now = new Date()) {
    const open = await this.listOpen();
    const openByNode = new Map(open.map((row) => [row.node_id, row]));
    const seen = new Set();
    for (const outage of outages) {
      seen.add(outage.node_id);
      const row = openByNode.get(outage.node_id);
      if (!row) {
        const since = outage.since ? new Date(outage.since) : now;
        await tinsertReturningId('outage_events', {
          node_id: outage.node_id,
          node_name: outage.name ?? null,
          started_at: since,
          peak_count: outage.count,
          total_clients: outage.total,
          created_at: now,
          updated_at: now
        });
        continue;
      }
      if (outage.count > row.peak_count || outage.total !== row.total_clients || (outage.name && outage.name !== row.node_name)) {
        await tdb('outage_events').where({ id: row.id }).update({
          peak_count: Math.max(row.peak_count, outage.count),
          total_clients: outage.total,
          node_name: outage.name ?? row.node_name,
          updated_at: now
        });
      }
    }
    for (const row of open) {
      if (seen.has(row.node_id)) continue;
      await tdb('outage_events').where({ id: row.id }).update({ ended_at: now, updated_at: now });
    }
  }

  /** As ocorrências mais recentes, com a duração em minutos (aberta: até agora). */
  static async recent({ days = 90, limit = 200, now = Date.now() } = {}) {
    const since = new Date(now - days * 86_400_000);
    const rows = await tdb('outage_events').where('started_at', '>=', since).orderBy('started_at', 'desc').limit(limit);
    return rows.map((row) => {
      const start = timestampMs(row.started_at);
      const end = row.ended_at ? timestampMs(row.ended_at) : now;
      return {
        id: row.id,
        node_id: row.node_id,
        node_name: row.node_name,
        started_at: new Date(start).toISOString(),
        ended_at: row.ended_at ? new Date(end).toISOString() : null,
        minutes: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 60_000)) : null,
        peak_count: row.peak_count,
        total_clients: row.total_clients
      };
    });
  }

  /** Por caixa: quantas vezes caiu e quanto tempo ficou fora, no período. */
  static summarize(events) {
    const byNode = new Map();
    for (const event of events) {
      const entry = byNode.get(event.node_id) ?? { node_id: event.node_id, node_name: event.node_name, count: 0, minutes: 0, last_at: event.started_at };
      entry.count += 1;
      entry.minutes += event.minutes ?? 0;
      if (event.started_at > entry.last_at) entry.last_at = event.started_at;
      entry.node_name = entry.node_name ?? event.node_name;
      byNode.set(event.node_id, entry);
    }
    return [...byNode.values()].sort((a, b) => b.count - a.count || b.minutes - a.minutes);
  }
}

export default OutageEvent;

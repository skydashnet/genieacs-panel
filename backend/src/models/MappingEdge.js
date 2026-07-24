import { getDb } from '../config/database.js';

function parseWaypoints(row) {
  if (!row) return row;
  let waypoints = row.waypoints;
  if (typeof waypoints === 'string') {
    try {
      waypoints = JSON.parse(waypoints);
    } catch {
      waypoints = null;
    }
  }
  return { ...row, waypoints };
}

class MappingEdge {
  static async getAll() {
    const rows = await getDb()('mapping_edges').select('*').orderBy('created_at', 'desc');
    return rows.map(parseWaypoints);
  }

  static async getByEdgeId(edgeId) {
    const row = await getDb()('mapping_edges').where({ edge_id: edgeId }).first();
    return row ? parseWaypoints(row) : null;
  }

  static async create(edgeData) {
    const { edge_id, source, target, fiber_type, distance, waypoints, notes } = edgeData;
    await getDb()('mapping_edges').insert({
      edge_id,
      source,
      target,
      fiber_type,
      distance,
      waypoints: waypoints ? JSON.stringify(waypoints) : null,
      notes
    });
    return edge_id;
  }

  static async update(edgeId, edgeData) {
    const { source, target, fiber_type, distance, waypoints, notes } = edgeData;
    const patch = { source, target, fiber_type, distance, notes, updated_at: getDb().fn.now() };
    if (waypoints !== undefined) {
      patch.waypoints = waypoints ? JSON.stringify(waypoints) : null;
    }
    const affected = await getDb()('mapping_edges').where({ edge_id: edgeId }).update(patch);
    return affected > 0;
  }

  static async delete(edgeId) {
    const affected = await getDb()('mapping_edges').where({ edge_id: edgeId }).del();
    return affected > 0;
  }

  static async deleteAll() {
    return getDb()('mapping_edges').del();
  }

  static async resetAll() {
    const db = getDb();
    await db.transaction(async (trx) => {
      await trx('mapping_edges').del();
      await trx('mapping_nodes').del();
    });
    return true;
  }

  static async syncData(nodes, edges) {
    const db = getDb();
    await db.transaction(async (trx) => {
      await trx('mapping_edges').del();
      await trx('mapping_nodes').del();

      if (nodes.length > 0) {
        await trx('mapping_nodes').insert(nodes.map((n) => ({
          node_id: n.node_id,
          type: n.type,
          name: n.name,
          latitude: n.latitude,
          longitude: n.longitude,
          capacity: n.capacity,
          splitter: n.splitter,
          pppoe: n.pppoe,
          notes: n.notes
        })));
      }

      if (edges.length > 0) {
        await trx('mapping_edges').insert(edges.map((e) => ({
          edge_id: e.edge_id,
          source: e.source,
          target: e.target,
          fiber_type: e.fiber_type,
          distance: e.distance,
          waypoints: e.waypoints ? JSON.stringify(e.waypoints) : null,
          notes: e.notes
        })));
      }
    });
    return true;
  }
}

export default MappingEdge;

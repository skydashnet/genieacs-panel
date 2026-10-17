import { getDb, tbatchInsert, tdb, tinsert } from '../config/database.js';

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
    const rows = await tdb('mapping_edges').select('*').orderBy('created_at', 'desc');
    return rows.map(parseWaypoints);
  }

  static async getByEdgeId(edgeId) {
    const row = await tdb('mapping_edges').where({ edge_id: edgeId }).first();
    return row ? parseWaypoints(row) : null;
  }

  static async create(edgeData) {
    const { edge_id, source, target, fiber_type, distance, waypoints, notes } = edgeData;
    await tinsert('mapping_edges', {
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
    const affected = await tdb('mapping_edges').where({ edge_id: edgeId }).update(patch);
    return affected > 0;
  }

  static async delete(edgeId) {
    const affected = await tdb('mapping_edges').where({ edge_id: edgeId }).del();
    return affected > 0;
  }

  static async deleteAll() {
    return tdb('mapping_edges').del();
  }

  /**
   * Clears the map of the provider in scope.
   *
   * Edges before nodes because of the foreign key, and both through the scoped
   * handle: unqualified, this emptied every provider's plant at once.
   */
  static async resetAll() {
    await getDb().transaction(async (trx) => {
      await tdb('mapping_edges', trx).del();
      await tdb('mapping_nodes', trx).del();
    });
    return true;
  }

  /**
   * Replaces the map of the provider in scope, wholesale.
   *
   * The delete and the insert both carry the provider. Scoping one and not the
   * other is how an import would quietly take everyone else's plant with it.
   */
  static async syncData(nodes, edges) {
    await getDb().transaction(async (trx) => {
      await tdb('mapping_edges', trx).del();
      await tdb('mapping_nodes', trx).del();

      if (nodes.length > 0) {
        await tinsert('mapping_nodes', nodes.map((n) => ({
          node_id: n.node_id,
          type: n.type,
          name: n.name,
          latitude: n.latitude,
          longitude: n.longitude,
          capacity: n.capacity,
          splitter: n.splitter,
          pppoe: n.pppoe,
          notes: n.notes
        })), trx);
      }

      if (edges.length > 0) {
        await tinsert('mapping_edges', edges.map((e) => ({
          edge_id: e.edge_id,
          source: e.source,
          target: e.target,
          fiber_type: e.fiber_type,
          distance: e.distance,
          waypoints: e.waypoints ? JSON.stringify(e.waypoints) : null,
          notes: e.notes
        })), trx);
      }
    });
    return true;
  }

  /**
   * Acrescenta pontos e cabos ao mapa do provedor — a importação de KML/KMZ.
   *
   * Ao contrário de `syncData`, não apaga nada: um id que já existe é pulado e
   * contado, nunca sobrescrito, para que importar o mesmo arquivo duas vezes
   * (ou um arquivo que repete um ponto desenhado à mão) não mexa no que está
   * lá. Um cabo cujo ponto não existe nem no mapa nem no lote volta em
   * `errors`. Tudo numa transação: ou o lote entra, ou nada entra.
   */
  static async importData(nodes, edges) {
    return getDb().transaction(async (trx) => {
      const existingNodes = new Set((await tdb('mapping_nodes', trx).select('node_id')).map((row) => row.node_id));
      const existingEdges = new Set((await tdb('mapping_edges', trx).select('edge_id')).map((row) => row.edge_id));

      const newNodes = nodes.filter((node) => !existingNodes.has(node.node_id));
      const known = new Set([...existingNodes, ...newNodes.map((node) => node.node_id)]);
      const errors = [];
      const newEdges = [];
      let skippedEdges = 0;
      for (const edge of edges) {
        if (existingEdges.has(edge.edge_id)) { skippedEdges += 1; continue; }
        if (!known.has(edge.source) || !known.has(edge.target)) { errors.push(edge.edge_id); continue; }
        newEdges.push(edge);
      }

      if (newNodes.length) {
        await tbatchInsert('mapping_nodes', newNodes.map((n) => ({
          node_id: n.node_id,
          type: n.type,
          name: n.name,
          latitude: n.latitude,
          longitude: n.longitude,
          capacity: n.capacity,
          splitter: n.splitter,
          pppoe: n.pppoe,
          notes: n.notes
        })), 100, trx);
      }
      if (newEdges.length) {
        await tbatchInsert('mapping_edges', newEdges.map((e) => ({
          edge_id: e.edge_id,
          source: e.source,
          target: e.target,
          fiber_type: e.fiber_type,
          distance: e.distance,
          waypoints: e.waypoints ? JSON.stringify(e.waypoints) : null,
          notes: e.notes
        })), 100, trx);
      }
      return {
        createdNodes: newNodes.length,
        createdEdges: newEdges.length,
        skippedNodes: nodes.length - newNodes.length,
        skippedEdges,
        errors
      };
    });
  }
}

export default MappingEdge;

import { executeQuery } from '../config/database.js';

class MappingEdge {
  static async getAll() {
    const query = 'SELECT * FROM mapping_edges ORDER BY created_at DESC';
    return await executeQuery(query);
  }

  static async getByEdgeId(edgeId) {
    const query = 'SELECT * FROM mapping_edges WHERE edge_id = ?';
    const rows = await executeQuery(query, [edgeId]);
    return rows.length > 0 ? rows[0] : null;
  }

  static async create(edgeData) {
    const {
      edge_id,
      source,
      target,
      fiber_type,
      distance,
      waypoints,
      notes
    } = edgeData;

    const waypointsJson = waypoints ? JSON.stringify(waypoints) : null;

    const query = `
      INSERT INTO mapping_edges (edge_id, source, target, fiber_type, distance, waypoints, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    
    const result = await executeQuery(query, [
      edge_id, source, target, fiber_type, distance, waypointsJson, notes
    ]);
    
    return result.insertId;
  }

  static async update(edgeId, edgeData) {
    const {
      fiber_type,
      distance,
      waypoints,
      notes
    } = edgeData;

    const waypointsJson = waypoints ? JSON.stringify(waypoints) : undefined;

    const query = `
      UPDATE mapping_edges SET 
        fiber_type = ?, distance = ?, waypoints = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE edge_id = ?
    `;
    
    const result = await executeQuery(query, [
      fiber_type, distance, waypointsJson, notes, edgeId
    ]);
    
    return result.affectedRows > 0;
  }

  static async delete(edgeId) {
    const query = 'DELETE FROM mapping_edges WHERE edge_id = ?';
    const result = await executeQuery(query, [edgeId]);
    return result.affectedRows > 0;
  }

  static async deleteAll() {
    const query = 'DELETE FROM mapping_edges';
    const result = await executeQuery(query);
    return result.affectedRows;
  }

  static async syncData(nodes, edges) {
    const queries = [
      { query: 'DELETE FROM mapping_edges' },
      { query: 'DELETE FROM mapping_nodes' }
    ];

    // Add node insert queries
    for (const node of nodes) {
      const {
        node_id,
        type,
        name,
        latitude,
        longitude,
        capacity,
        splitter,
        pppoe,
        notes
      } = node;

      queries.push({
        query: `
          INSERT INTO mapping_nodes (node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        params: [node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes]
      });
    }

    // Add edge insert queries
    for (const edge of edges) {
      const {
        edge_id,
        source,
        target,
        fiber_type,
        distance,
        waypoints,
        notes
      } = edge;

      const waypointsJson = waypoints ? JSON.stringify(waypoints) : null;

      queries.push({
        query: `
          INSERT INTO mapping_edges (edge_id, source, target, fiber_type, distance, waypoints, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        params: [edge_id, source, target, fiber_type, distance, waypointsJson, notes]
      });
    }

    const { executeTransaction } = await import('../config/database.js');
    return await executeTransaction(queries);
  }
}

export default MappingEdge;
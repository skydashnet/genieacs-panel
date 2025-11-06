import { executeQuery } from '../config/database.js';

class MappingNode {
  static async getAll() {
    const query = 'SELECT * FROM mapping_nodes ORDER BY created_at DESC';
    return await executeQuery(query);
  }

  static async getByNodeId(nodeId) {
    const query = 'SELECT * FROM mapping_nodes WHERE node_id = ?';
    const rows = await executeQuery(query, [nodeId]);
    return rows.length > 0 ? rows[0] : null;
  }

  static async create(nodeData) {
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
    } = nodeData;

    const query = `
      INSERT INTO mapping_nodes (node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const result = await executeQuery(query, [
      node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes
    ]);
    
    return result.insertId;
  }

  static async update(nodeId, nodeData) {
    const {
      name,
      latitude,
      longitude,
      capacity,
      splitter,
      pppoe,
      notes
    } = nodeData;

    const query = `
      UPDATE mapping_nodes SET 
        name = ?, latitude = ?, longitude = ?, capacity = ?, splitter = ?, pppoe = ?, notes = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE node_id = ?
    `;
    
    const result = await executeQuery(query, [
      name, latitude, longitude, capacity, splitter, pppoe, notes, nodeId
    ]);
    
    return result.affectedRows > 0;
  }

  static async delete(nodeId) {
    const query = 'DELETE FROM mapping_nodes WHERE node_id = ?';
    const result = await executeQuery(query, [nodeId]);
    return result.affectedRows > 0;
  }

  static async deleteAll() {
    const query = 'DELETE FROM mapping_nodes';
    const result = await executeQuery(query);
    return result.affectedRows;
  }
}

export default MappingNode;
import { getDb, tdb, tinsertReturningId } from '../config/database.js';

class MappingNode {
  static async getAll() {
    return tdb('mapping_nodes').orderBy('created_at', 'desc');
  }

  static async getByNodeId(nodeId) {
    const row = await tdb('mapping_nodes').where({ node_id: nodeId }).first();
    return row || null;
  }

  static async create(nodeData) {
    const { node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes } = nodeData;
    return tinsertReturningId('mapping_nodes', {
      node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes
    });
  }

  static async update(nodeId, nodeData) {
    const { type, name, latitude, longitude, capacity, splitter, pppoe, notes } = nodeData;
    const count = await tdb('mapping_nodes').where({ node_id: nodeId }).update({
      type, name, latitude, longitude, capacity, splitter, pppoe, notes,
      updated_at: getDb().fn.now()
    });
    return count > 0;
  }

  static async delete(nodeId) {
    const count = await tdb('mapping_nodes').where({ node_id: nodeId }).del();
    return count > 0;
  }

  /** Every node of the provider in scope, and no one else's. */
  static async deleteAll() {
    return tdb('mapping_nodes').del();
  }
}

export default MappingNode;

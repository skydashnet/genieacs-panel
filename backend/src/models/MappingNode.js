import { getDb } from '../config/database.js';

class MappingNode {
  static async getAll() {
    return getDb()('mapping_nodes').orderBy('created_at', 'desc');
  }

  static async getByNodeId(nodeId) {
    const row = await getDb()('mapping_nodes').where({ node_id: nodeId }).first();
    return row || null;
  }

  static async create(nodeData) {
    const { node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes } = nodeData;
    const [id] = await getDb()('mapping_nodes').insert({
      node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes
    });
    return id;
  }

  static async update(nodeId, nodeData) {
    const { name, latitude, longitude, capacity, splitter, pppoe, notes } = nodeData;
    const count = await getDb()('mapping_nodes').where({ node_id: nodeId }).update({
      name, latitude, longitude, capacity, splitter, pppoe, notes,
      updated_at: getDb().fn.now()
    });
    return count > 0;
  }

  static async delete(nodeId) {
    const count = await getDb()('mapping_nodes').where({ node_id: nodeId }).del();
    return count > 0;
  }

  static async deleteAll() {
    return getDb()('mapping_nodes').del();
  }
}

export default MappingNode;

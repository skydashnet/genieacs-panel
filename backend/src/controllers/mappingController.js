import MappingNode from '../models/MappingNode.js';
import MappingEdge from '../models/MappingEdge.js';
import User from '../models/User.js';
import bcrypt from 'bcryptjs';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

class MappingController {
  static async getAllNodes(req, res) {
    try {
      const nodes = await MappingNode.getAll();
      return res.json(
        createResponse('Mapping nodes retrieved successfully', nodes)
      );
    } catch (error) {
      console.error('Get all mapping nodes error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get mapping nodes', error.message)
      );
    }
  }

  static async getNodeByNodeId(req, res) {
    try {
      const { nodeId } = req.params;
      
      if (!nodeId) {
        return res.status(400).json(
          createErrorResponse('Node ID is required')
        );
      }

      const node = await MappingNode.getByNodeId(nodeId);
      
      if (!node) {
        return res.status(404).json(
          createErrorResponse('Node not found')
        );
      }

      return res.json(
        createResponse('Node retrieved successfully', node)
      );
    } catch (error) {
      console.error('Get node by ID error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get node', error.message)
      );
    }
  }

  static async createNode(req, res) {
    try {
      const { node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes } = req.body;
      
      if (!node_id || !type || !name || latitude === undefined || longitude === undefined) {
        return res.status(400).json(
          createErrorResponse('Required fields: node_id, type, name, latitude, longitude')
        );
      }

      if (!['server', 'odc', 'odp', 'ont'].includes(type)) {
        return res.status(400).json(
          createErrorResponse('Invalid type. Must be: server, odc, odp, or ont')
        );
      }

      const nodeId = await MappingNode.create({
        node_id,
        type,
        name,
        latitude,
        longitude,
        capacity,
        splitter,
        pppoe,
        notes
      });
      
      return res.status(201).json(
        createResponse('Node created successfully', { id: nodeId })
      );
    } catch (error) {
      console.error('Create node error:', error);
      
      if (
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        error.code === 'ER_DUP_ENTRY' ||
        error.message.includes('UNIQUE constraint failed')
      ) {
        return res.status(409).json(
          createErrorResponse('Node ID already exists')
        );
      }
      
      return res.status(500).json(
        createErrorResponse('Failed to create node', error.message)
      );
    }
  }

  static async updateNode(req, res) {
    try {
      const { nodeId } = req.params;
      const { name, latitude, longitude, capacity, splitter, pppoe, notes } = req.body;
      
      if (!nodeId) {
        return res.status(400).json(
          createErrorResponse('Node ID is required')
        );
      }

      const updated = await MappingNode.update(nodeId, {
        name,
        latitude,
        longitude,
        capacity,
        splitter,
        pppoe,
        notes
      });
      
      if (!updated) {
        return res.status(404).json(
          createErrorResponse('Node not found')
        );
      }

      return res.json(
        createResponse('Node updated successfully')
      );
    } catch (error) {
      console.error('Update node error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update node', error.message)
      );
    }
  }

  static async deleteNode(req, res) {
    try {
      const { nodeId } = req.params;
      
      if (!nodeId) {
        return res.status(400).json(
          createErrorResponse('Node ID is required')
        );
      }

      const deleted = await MappingNode.delete(nodeId);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse('Node not found')
        );
      }

      return res.json(
        createResponse('Node deleted successfully')
      );
    } catch (error) {
      console.error('Delete node error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to delete node', error.message)
      );
    }
  }

  static async getAllEdges(req, res) {
    try {
      const edges = await MappingEdge.getAll();
      return res.json(
        createResponse('Mapping edges retrieved successfully', edges)
      );
    } catch (error) {
      console.error('Get all mapping edges error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get mapping edges', error.message)
      );
    }
  }

  static async getEdgeByEdgeId(req, res) {
    try {
      const { edgeId } = req.params;
      
      if (!edgeId) {
        return res.status(400).json(
          createErrorResponse('Edge ID is required')
        );
      }

      const edge = await MappingEdge.getByEdgeId(edgeId);
      
      if (!edge) {
        return res.status(404).json(
          createErrorResponse('Edge not found')
        );
      }

      return res.json(
        createResponse('Edge retrieved successfully', edge)
      );
    } catch (error) {
      console.error('Get edge by ID error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get edge', error.message)
      );
    }
  }

  static async createEdge(req, res) {
    try {
      const { edge_id, source, target, fiber_type, distance, waypoints, notes } = req.body;
      
      if (!edge_id || !source || !target) {
        return res.status(400).json(
          createErrorResponse('Required fields: edge_id, source, target')
        );
      }

      if (fiber_type && !['feeder', 'distribution', 'drop'].includes(fiber_type)) {
        return res.status(400).json(
          createErrorResponse('Invalid fiber_type. Must be: feeder, distribution, or drop')
        );
      }

      const edgeId = await MappingEdge.create({
        edge_id,
        source,
        target,
        fiber_type,
        distance,
        waypoints,
        notes
      });
      
      return res.status(201).json(
        createResponse('Edge created successfully', { id: edgeId })
      );
    } catch (error) {
      console.error('Create edge error:', error);
      
      if (
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        error.code === 'ER_DUP_ENTRY' ||
        error.message.includes('UNIQUE constraint failed')
      ) {
        return res.status(409).json(
          createErrorResponse('Edge ID already exists')
        );
      }
      
      if (
        error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
        error.code === 'ER_NO_REFERENCED_ROW_2' ||
        error.message.includes('FOREIGN KEY constraint failed')
      ) {
        return res.status(400).json(
          createErrorResponse('Source or target node does not exist')
        );
      }
      
      return res.status(500).json(
        createErrorResponse('Failed to create edge', error.message)
      );
    }
  }

  static async updateEdge(req, res) {
    try {
      const { edgeId } = req.params;
      const { fiber_type, distance, waypoints, notes } = req.body;
      
      if (!edgeId) {
        return res.status(400).json(
          createErrorResponse('Edge ID is required')
        );
      }

      if (fiber_type && !['feeder', 'distribution', 'drop'].includes(fiber_type)) {
        return res.status(400).json(
          createErrorResponse('Invalid fiber_type. Must be: feeder, distribution, or drop')
        );
      }

      const updated = await MappingEdge.update(edgeId, {
        fiber_type,
        distance,
        waypoints,
        notes
      });
      
      if (!updated) {
        return res.status(404).json(
          createErrorResponse('Edge not found')
        );
      }

      return res.json(
        createResponse('Edge updated successfully')
      );
    } catch (error) {
      console.error('Update edge error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update edge', error.message)
      );
    }
  }

  static async deleteEdge(req, res) {
    try {
      const { edgeId } = req.params;
      
      if (!edgeId) {
        return res.status(400).json(
          createErrorResponse('Edge ID is required')
        );
      }

      const deleted = await MappingEdge.delete(edgeId);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse('Edge not found')
        );
      }

      return res.json(
        createResponse('Edge deleted successfully')
      );
    } catch (error) {
      console.error('Delete edge error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to delete edge', error.message)
      );
    }
  }

  static async syncMappingData(req, res) {
    try {
      const { nodes, edges } = req.body;
      
      if (!Array.isArray(nodes) || !Array.isArray(edges)) {
        return res.status(400).json(
          createErrorResponse('Invalid data format. Expected { nodes: [], edges: [] }')
        );
      }

      await MappingEdge.syncData(nodes, edges);
      
      return res.json(
        createResponse('Mapping data synchronized successfully', {
          summary: {
            nodes: nodes.length,
            edges: edges.length
          }
        })
      );
    } catch (error) {
      console.error('Sync mapping data error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to sync mapping data', error.message)
      );
    }
  }

  static async resetMappingData(req, res) {
    try {
      const { password } = req.body;
      
      if (!password) {
        return res.status(400).json(
          createErrorResponse('Password is required')
        );
      }

      const user = await User.findById(req.user.userId);
      
      if (!user || user.role !== 'admin') {
        return res.status(403).json(
          createErrorResponse('Insufficient permissions')
        );
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      
      if (!isPasswordValid) {
        return res.status(400).json(
          createErrorResponse('Invalid password. Please try again.')
        );
      }

      await MappingEdge.resetAll();
      
      return res.json(
        createResponse('All mapping data has been deleted successfully')
      );
    } catch (error) {
      console.error('Reset mapping data error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to reset mapping data', error.message)
      );
    }
  }
}

export default MappingController;

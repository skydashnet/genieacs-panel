import MappingNode from '../models/MappingNode.js';
import MappingEdge from '../models/MappingEdge.js';
import User from '../models/User.js';
import bcrypt from 'bcryptjs';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

const NODE_TYPES = new Set(['htb', 'olt', 'odc', 'odp', 'ont', 'server']);
const FIBER_TYPES = new Set(['backbone', 'feeder', 'distribution', 'drop', 'patch']);

function validateNodePayload(payload) {
  const nodeId = String(payload.node_id || '').trim();
  const type = String(payload.type || '').trim().toLowerCase();
  const name = String(payload.name || '').trim();
  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  const capacity = payload.capacity === '' || payload.capacity === null || payload.capacity === undefined
    ? null
    : Number(payload.capacity);

  if (!nodeId || nodeId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(nodeId)) {
    return { error: 'Node ID is required and may only contain letters, numbers, dot, underscore, colon, or dash.' };
  }
  if (!NODE_TYPES.has(type)) {
    return { error: 'Invalid type. Must be: HTB, OLT, ODC, ODP, ONT, or server.' };
  }
  if (!name || name.length > 255) {
    return { error: 'Node name is required and must not exceed 255 characters.' };
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { error: 'Latitude must be between -90 and 90.' };
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { error: 'Longitude must be between -180 and 180.' };
  }
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0 || capacity > 1_000_000)) {
    return { error: 'Capacity must be a non-negative integer.' };
  }

  return {
    value: {
      node_id: nodeId,
      type,
      name,
      latitude,
      longitude,
      capacity,
      splitter: String(payload.splitter || '').trim().slice(0, 64) || null,
      pppoe: String(payload.pppoe || '').trim().slice(0, 255) || null,
      notes: String(payload.notes || '').trim().slice(0, 5000) || null
    }
  };
}

function validateWaypoints(waypoints) {
  if (waypoints === null || waypoints === undefined || waypoints === '') return { value: null };
  if (!Array.isArray(waypoints) || waypoints.length > 100) {
    return { error: 'Waypoints must be an array with at most 100 coordinates.' };
  }
  const normalized = [];
  for (const point of waypoints) {
    if (!Array.isArray(point) || point.length !== 2) {
      return { error: 'Every waypoint must be a [latitude, longitude] pair.' };
    }
    const latitude = Number(point[0]);
    const longitude = Number(point[1]);
    if (
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    ) {
      return { error: 'Waypoint coordinates are outside valid latitude/longitude ranges.' };
    }
    normalized.push([latitude, longitude]);
  }
  return { value: normalized };
}

function validateEdgePayload(payload) {
  const edgeId = String(payload.edge_id || '').trim();
  const source = String(payload.source || '').trim();
  const target = String(payload.target || '').trim();
  const fiberType = String(payload.fiber_type || 'distribution').trim().toLowerCase();
  const distance = payload.distance === '' || payload.distance === null || payload.distance === undefined
    ? null
    : Number(payload.distance);
  const waypoints = validateWaypoints(payload.waypoints);

  if (!edgeId || edgeId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(edgeId)) {
    return { error: 'Cable ID is required and may only contain letters, numbers, dot, underscore, colon, or dash.' };
  }
  if (!source || !target) return { error: 'Source and target nodes are required.' };
  if (source === target) return { error: 'Source and target nodes must be different.' };
  if (!FIBER_TYPES.has(fiberType)) {
    return { error: 'Invalid cable type. Must be: backbone, feeder, distribution, drop, or patch.' };
  }
  if (distance !== null && (!Number.isFinite(distance) || distance < 0 || distance > 1_000_000)) {
    return { error: 'Distance must be a non-negative number.' };
  }
  if (waypoints.error) return waypoints;

  return {
    value: {
      edge_id: edgeId,
      source,
      target,
      fiber_type: fiberType,
      distance,
      waypoints: waypoints.value,
      notes: String(payload.notes || '').trim().slice(0, 5000) || null
    }
  };
}

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
      const validated = validateNodePayload(req.body || {});
      if (validated.error) {
        return res.status(400).json(createErrorResponse(validated.error));
      }
      const nodeId = await MappingNode.create(validated.value);
      
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
      
      if (!nodeId) {
        return res.status(400).json(
          createErrorResponse('Node ID is required')
        );
      }

      const validated = validateNodePayload({ ...(req.body || {}), node_id: nodeId });
      if (validated.error) {
        return res.status(400).json(createErrorResponse(validated.error));
      }
      const updated = await MappingNode.update(nodeId, validated.value);
      
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
      const validated = validateEdgePayload(req.body || {});
      if (validated.error) {
        return res.status(400).json(createErrorResponse(validated.error));
      }
      const edgeId = await MappingEdge.create(validated.value);
      
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
      
      if (!edgeId) {
        return res.status(400).json(
          createErrorResponse('Edge ID is required')
        );
      }

      const validated = validateEdgePayload({ ...(req.body || {}), edge_id: edgeId });
      if (validated.error) {
        return res.status(400).json(createErrorResponse(validated.error));
      }
      const updated = await MappingEdge.update(edgeId, validated.value);
      
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

      if (nodes.length > 10_000 || edges.length > 20_000) {
        return res.status(400).json(createErrorResponse('Mapping import is too large.'));
      }
      const validatedNodes = [];
      const nodeIds = new Set();
      for (const node of nodes) {
        const validated = validateNodePayload(node || {});
        if (validated.error) {
          return res.status(400).json(createErrorResponse(`Invalid node: ${validated.error}`));
        }
        if (nodeIds.has(validated.value.node_id)) {
          return res.status(400).json(createErrorResponse(`Duplicate node ID: ${validated.value.node_id}`));
        }
        nodeIds.add(validated.value.node_id);
        validatedNodes.push(validated.value);
      }
      const validatedEdges = [];
      const edgeIds = new Set();
      for (const edge of edges) {
        const validated = validateEdgePayload(edge || {});
        if (validated.error) {
          return res.status(400).json(createErrorResponse(`Invalid cable: ${validated.error}`));
        }
        if (edgeIds.has(validated.value.edge_id)) {
          return res.status(400).json(createErrorResponse(`Duplicate cable ID: ${validated.value.edge_id}`));
        }
        if (!nodeIds.has(validated.value.source) || !nodeIds.has(validated.value.target)) {
          return res.status(400).json(createErrorResponse(`Cable ${validated.value.edge_id} references an unknown node.`));
        }
        edgeIds.add(validated.value.edge_id);
        validatedEdges.push(validated.value);
      }

      await MappingEdge.syncData(validatedNodes, validatedEdges);
      
      return res.json(
        createResponse('Mapping data synchronized successfully', {
          summary: {
            nodes: validatedNodes.length,
            edges: validatedEdges.length
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

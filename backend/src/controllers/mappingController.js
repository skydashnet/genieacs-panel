import MappingNode from '../models/MappingNode.js';
import MappingEdge from '../models/MappingEdge.js';
import User from '../models/User.js';
import bcrypt from 'bcryptjs';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { searchPlaces } from '../services/addressLookupService.js';
import MapStatusService from '../services/mapStatusService.js';
import OutageEvent from '../models/OutageEvent.js';
import ClientLocationService from '../services/clientLocationService.js';
import { classifySyncError } from '../services/customerSyncErrors.js';

/**
 * A política de uso do Nominatim é de uma consulta por segundo por
 * aplicação — o painel inteiro, não cada provedor. As buscas fazem fila; se a
 * fila passar de alguns segundos, a próxima ouve "tente de novo" em vez de
 * esperar sem fim.
 */
const searchQueue = { next: 0 };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
    return { errorKey: 'mapping.validation.nodeId' };
  }
  if (!NODE_TYPES.has(type)) {
    return { errorKey: 'mapping.validation.nodeType' };
  }
  if (!name || name.length > 255) {
    return { errorKey: 'mapping.validation.nodeName' };
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { errorKey: 'mapping.validation.latitude' };
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { errorKey: 'mapping.validation.longitude' };
  }
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0 || capacity > 1_000_000)) {
    return { errorKey: 'mapping.validation.capacity' };
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
    return { errorKey: 'mapping.validation.waypointsArray' };
  }
  const normalized = [];
  for (const point of waypoints) {
    if (!Array.isArray(point) || point.length !== 2) {
      return { errorKey: 'mapping.validation.waypointPair' };
    }
    const latitude = Number(point[0]);
    const longitude = Number(point[1]);
    if (
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    ) {
      return { errorKey: 'mapping.validation.waypointRange' };
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
    return { errorKey: 'mapping.validation.cableId' };
  }
  if (!source || !target) return { errorKey: 'mapping.validation.endpointsRequired' };
  if (source === target) return { errorKey: 'mapping.validation.endpointsDistinct' };
  if (!FIBER_TYPES.has(fiberType)) {
    return { errorKey: 'mapping.validation.cableType' };
  }
  if (distance !== null && (!Number.isFinite(distance) || distance < 0 || distance > 1_000_000)) {
    return { errorKey: 'mapping.validation.distance' };
  }
  if (waypoints.errorKey) return waypoints;

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
  /** Intervalo entre consultas ao Nominatim (os testes zeram). */
  static SEARCH_INTERVAL_MS = 1_000;
  static SEARCH_MAX_WAIT_MS = 5_000;

  /** Estado ao vivo dos pontos com PPPoE — ver `MapStatusService`. */
  static async liveStatus(req, res) {
    try {
      return res.json(createResponse(req.t('mapping.statusReady'), await MapStatusService.status()));
    } catch (error) {
      console.warn(`Map live status failed: ${error.message}`);
      // Mesmo classificador da sincronização de IDs: diz se o ACS não
      // respondeu, recusou a credencial ou nem está configurado.
      const reason = classifySyncError(error);
      const message = reason.code === 'database'
        ? req.t('mapping.statusFailed')
        : req.t(reason.reasonKey, reason.status ? { status: reason.status } : undefined);
      return res.status(502).json(createErrorResponse(message, error.message, reason.code));
    }
  }

  /** Onde fica a casa do cliente (endereço do SGP), para o "Colocar no mapa". */
  static async clientLocation(req, res) {
    try {
      const pppoe = String(req.query.pppoe ?? '').slice(0, 255);
      const deviceId = String(req.query.deviceId ?? '').slice(0, 255);
      if (!pppoe.trim() && !deviceId.trim()) {
        return res.status(400).json(createErrorResponse(req.t('mapping.clientLocationMissing')));
      }
      return res.json(createResponse(req.t('mapping.statusReady'), await ClientLocationService.locate({ pppoe, deviceId })));
    } catch (error) {
      console.error('Client location error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /** Equipamentos com PPPoE que ainda não estão no mapa. */
  static async unmappedDevices(req, res) {
    try {
      return res.json(createResponse(req.t('mapping.statusReady'), await MapStatusService.unmapped()));
    } catch (error) {
      console.warn(`Unmapped devices failed: ${error.message}`);
      const reason = classifySyncError(error);
      const message = reason.code === 'database'
        ? req.t('mapping.statusFailed')
        : req.t(reason.reasonKey, reason.status ? { status: reason.status } : undefined);
      return res.status(502).json(createErrorResponse(message, error.message, reason.code));
    }
  }

  /**
   * "Colocar todos no mapa": os equipamentos fora do mapa, separados entre os
   * que o SGP já dá as coordenadas, os que só têm endereço e os sem endereço.
   * A gravação vai pelo `/import`, que acrescenta e ignora o que já existe.
   */
  static async bulkPlacement(req, res) {
    try {
      const { total, items } = await MapStatusService.unmapped({ limit: 5000 });
      const groups = await ClientLocationService.locateMany(items);
      return res.json(createResponse(req.t('mapping.statusReady'), { total, truncated: total > items.length, ...groups }));
    } catch (error) {
      console.warn(`Bulk placement failed: ${error.message}`);
      const reason = classifySyncError(error);
      const message = reason.code === 'database'
        ? req.t('mapping.statusFailed')
        : req.t(reason.reasonKey, reason.status ? { status: reason.status } : undefined);
      return res.status(502).json(createErrorResponse(message, error.message, reason.code));
    }
  }

  /** Histórico de rompimentos: as ocorrências e o resumo por caixa. */
  static async outageHistory(req, res) {
    try {
      const days = Math.min(365, Math.max(1, Number.parseInt(String(req.query.days ?? '90'), 10) || 90));
      const events = await OutageEvent.recent({ days });
      return res.json(createResponse(req.t('mapping.outagesReady'), { days, events, byNode: OutageEvent.summarize(events) }));
    } catch (error) {
      console.error('Outage history error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  static async searchAddress(req, res) {
    const q = String(req.query.q ?? '').replace(/\s+/g, ' ').trim();
    if (q.length < 3 || q.length > 200) {
      return res.status(400).json(createErrorResponse(req.t('mapping.searchTooShort')));
    }
    const now = Date.now();
    const wait = Math.max(0, searchQueue.next - now);
    if (wait > MappingController.SEARCH_MAX_WAIT_MS) {
      return res.status(429).json(createErrorResponse(req.t('mapping.searchBusy')));
    }
    searchQueue.next = Math.max(now, searchQueue.next) + MappingController.SEARCH_INTERVAL_MS;
    if (wait) await sleep(wait);
    try {
      const results = await searchPlaces(q, { limit: 5 });
      return res.json(createResponse(req.t('mapping.searchDone'), results));
    } catch (error) {
      console.warn(`Map address search failed: ${error.message}`);
      return res.status(502).json(createErrorResponse(req.t('mapping.searchFailed'), error.message));
    }
  }

  static async getAllNodes(req, res) {
    try {
      const nodes = await MappingNode.getAll();
      return res.json(
        createResponse(req.t('mapping.nodesRetrieved'), nodes)
      );
    } catch (error) {
      console.error('Get all mapping nodes error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapping.nodesFailed'), error.message)
      );
    }
  }

  static async getNodeByNodeId(req, res) {
    try {
      const { nodeId } = req.params;
      
      if (!nodeId) {
        return res.status(400).json(
          createErrorResponse(req.t('mapping.nodeIdRequired'))
        );
      }

      const node = await MappingNode.getByNodeId(nodeId);
      
      if (!node) {
        return res.status(404).json(
          createErrorResponse(req.t('mapping.nodeNotFound'))
        );
      }

      return res.json(
        createResponse(req.t('mapping.nodeRetrieved'), node)
      );
    } catch (error) {
      console.error('Get node by ID error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapping.nodeGetFailed'), error.message)
      );
    }
  }

  static async createNode(req, res) {
    try {
      const validated = validateNodePayload(req.body || {});
      if (validated.errorKey) {
        return res.status(400).json(createErrorResponse(req.t(validated.errorKey)));
      }
      const nodeId = await MappingNode.create(validated.value);
      
      return res.status(201).json(
        createResponse(req.t('mapping.nodeCreated'), { id: nodeId })
      );
    } catch (error) {
      console.error('Create node error:', error);
      
      if (
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        error.code === 'ER_DUP_ENTRY' ||
        error.message.includes('UNIQUE constraint failed')
      ) {
        return res.status(409).json(
          createErrorResponse(req.t('mapping.nodeIdExists'))
        );
      }
      
      return res.status(500).json(
        createErrorResponse(req.t('mapping.nodeCreateFailed'), error.message)
      );
    }
  }

  static async updateNode(req, res) {
    try {
      const { nodeId } = req.params;
      
      if (!nodeId) {
        return res.status(400).json(
          createErrorResponse(req.t('mapping.nodeIdRequired'))
        );
      }

      const validated = validateNodePayload({ ...(req.body || {}), node_id: nodeId });
      if (validated.errorKey) {
        return res.status(400).json(createErrorResponse(req.t(validated.errorKey)));
      }
      const updated = await MappingNode.update(nodeId, validated.value);
      
      if (!updated) {
        return res.status(404).json(
          createErrorResponse(req.t('mapping.nodeNotFound'))
        );
      }

      return res.json(
        createResponse(req.t('mapping.nodeUpdated'))
      );
    } catch (error) {
      console.error('Update node error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapping.nodeUpdateFailed'), error.message)
      );
    }
  }

  static async deleteNode(req, res) {
    try {
      const { nodeId } = req.params;
      
      if (!nodeId) {
        return res.status(400).json(
          createErrorResponse(req.t('mapping.nodeIdRequired'))
        );
      }

      const deleted = await MappingNode.delete(nodeId);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse(req.t('mapping.nodeNotFound'))
        );
      }

      return res.json(
        createResponse(req.t('mapping.nodeDeleted'))
      );
    } catch (error) {
      console.error('Delete node error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapping.nodeDeleteFailed'), error.message)
      );
    }
  }

  static async getAllEdges(req, res) {
    try {
      const edges = await MappingEdge.getAll();
      return res.json(
        createResponse(req.t('mapping.edgesRetrieved'), edges)
      );
    } catch (error) {
      console.error('Get all mapping edges error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapping.edgesFailed'), error.message)
      );
    }
  }

  static async getEdgeByEdgeId(req, res) {
    try {
      const { edgeId } = req.params;
      
      if (!edgeId) {
        return res.status(400).json(
          createErrorResponse(req.t('mapping.edgeIdRequired'))
        );
      }

      const edge = await MappingEdge.getByEdgeId(edgeId);
      
      if (!edge) {
        return res.status(404).json(
          createErrorResponse(req.t('mapping.edgeNotFound'))
        );
      }

      return res.json(
        createResponse(req.t('mapping.edgeRetrieved'), edge)
      );
    } catch (error) {
      console.error('Get edge by ID error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapping.edgeGetFailed'), error.message)
      );
    }
  }

  static async createEdge(req, res) {
    try {
      const validated = validateEdgePayload(req.body || {});
      if (validated.errorKey) {
        return res.status(400).json(createErrorResponse(req.t(validated.errorKey)));
      }
      const edgeId = await MappingEdge.create(validated.value);
      
      return res.status(201).json(
        createResponse(req.t('mapping.edgeCreated'), { id: edgeId })
      );
    } catch (error) {
      console.error('Create edge error:', error);
      
      if (
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        error.code === 'ER_DUP_ENTRY' ||
        error.message.includes('UNIQUE constraint failed')
      ) {
        return res.status(409).json(
          createErrorResponse(req.t('mapping.edgeIdExists'))
        );
      }
      
      if (
        error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
        error.code === 'ER_NO_REFERENCED_ROW_2' ||
        error.message.includes('FOREIGN KEY constraint failed')
      ) {
        return res.status(400).json(
          createErrorResponse(req.t('mapping.endpointsMissing'))
        );
      }
      
      return res.status(500).json(
        createErrorResponse(req.t('mapping.edgeCreateFailed'), error.message)
      );
    }
  }

  static async updateEdge(req, res) {
    try {
      const { edgeId } = req.params;
      
      if (!edgeId) {
        return res.status(400).json(
          createErrorResponse(req.t('mapping.edgeIdRequired'))
        );
      }

      const validated = validateEdgePayload({ ...(req.body || {}), edge_id: edgeId });
      if (validated.errorKey) {
        return res.status(400).json(createErrorResponse(req.t(validated.errorKey)));
      }
      const updated = await MappingEdge.update(edgeId, validated.value);
      
      if (!updated) {
        return res.status(404).json(
          createErrorResponse(req.t('mapping.edgeNotFound'))
        );
      }

      return res.json(
        createResponse(req.t('mapping.edgeUpdated'))
      );
    } catch (error) {
      console.error('Update edge error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapping.edgeUpdateFailed'), error.message)
      );
    }
  }

  static async deleteEdge(req, res) {
    try {
      const { edgeId } = req.params;
      
      if (!edgeId) {
        return res.status(400).json(
          createErrorResponse(req.t('mapping.edgeIdRequired'))
        );
      }

      const deleted = await MappingEdge.delete(edgeId);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse(req.t('mapping.edgeNotFound'))
        );
      }

      return res.json(
        createResponse(req.t('mapping.edgeDeleted'))
      );
    } catch (error) {
      console.error('Delete edge error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapping.edgeDeleteFailed'), error.message)
      );
    }
  }

  static async syncMappingData(req, res) {
    try {
      const { nodes, edges } = req.body;
      
      if (!Array.isArray(nodes) || !Array.isArray(edges)) {
        return res.status(400).json(
          createErrorResponse(req.t('mapping.invalidFormat'))
        );
      }

      if (nodes.length > 10_000 || edges.length > 20_000) {
        return res.status(400).json(createErrorResponse(req.t('mapping.importTooLarge')));
      }
      const validatedNodes = [];
      const nodeIds = new Set();
      for (const node of nodes) {
        const validated = validateNodePayload(node || {});
        if (validated.errorKey) {
          return res.status(400).json(createErrorResponse(
            req.t('mapping.invalidNode', { error: req.t(validated.errorKey) })
          ));
        }
        if (nodeIds.has(validated.value.node_id)) {
          return res.status(400).json(createErrorResponse(
            req.t('mapping.duplicateNodeId', { id: validated.value.node_id })
          ));
        }
        nodeIds.add(validated.value.node_id);
        validatedNodes.push(validated.value);
      }
      const validatedEdges = [];
      const edgeIds = new Set();
      for (const edge of edges) {
        const validated = validateEdgePayload(edge || {});
        if (validated.errorKey) {
          return res.status(400).json(createErrorResponse(
            req.t('mapping.invalidCable', { error: req.t(validated.errorKey) })
          ));
        }
        if (edgeIds.has(validated.value.edge_id)) {
          return res.status(400).json(createErrorResponse(
            req.t('mapping.duplicateCableId', { id: validated.value.edge_id })
          ));
        }
        if (!nodeIds.has(validated.value.source) || !nodeIds.has(validated.value.target)) {
          return res.status(400).json(createErrorResponse(
            req.t('mapping.cableUnknownNode', { id: validated.value.edge_id })
          ));
        }
        edgeIds.add(validated.value.edge_id);
        validatedEdges.push(validated.value);
      }

      await MappingEdge.syncData(validatedNodes, validatedEdges);
      
      return res.json(
        createResponse(req.t('mapping.synced'), {
          summary: {
            nodes: validatedNodes.length,
            edges: validatedEdges.length
          }
        })
      );
    } catch (error) {
      console.error('Sync mapping data error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapping.syncFailed'), error.message)
      );
    }
  }

  /**
   * Importação de KML/KMZ: o navegador lê o arquivo e manda pontos e cabos em
   * lotes. Acrescenta, não substitui — ver `MappingEdge.importData`.
   */
  static async importMappingData(req, res) {
    try {
      const { nodes, edges } = req.body || {};
      if (!Array.isArray(nodes) || !Array.isArray(edges)) {
        return res.status(400).json(createErrorResponse(req.t('mapping.invalidFormat')));
      }
      if (nodes.length > 2_000 || edges.length > 4_000) {
        return res.status(400).json(createErrorResponse(req.t('mapping.importTooLarge')));
      }
      const validatedNodes = [];
      const nodeIds = new Set();
      for (const node of nodes) {
        const validated = validateNodePayload(node || {});
        if (validated.errorKey) {
          return res.status(400).json(createErrorResponse(
            req.t('mapping.invalidNode', { error: req.t(validated.errorKey) })
          ));
        }
        if (nodeIds.has(validated.value.node_id)) {
          return res.status(400).json(createErrorResponse(
            req.t('mapping.duplicateNodeId', { id: validated.value.node_id })
          ));
        }
        nodeIds.add(validated.value.node_id);
        validatedNodes.push(validated.value);
      }
      const validatedEdges = [];
      const edgeIds = new Set();
      for (const edge of edges) {
        const validated = validateEdgePayload(edge || {});
        if (validated.errorKey) {
          return res.status(400).json(createErrorResponse(
            req.t('mapping.invalidCable', { error: req.t(validated.errorKey) })
          ));
        }
        if (edgeIds.has(validated.value.edge_id)) {
          return res.status(400).json(createErrorResponse(
            req.t('mapping.duplicateCableId', { id: validated.value.edge_id })
          ));
        }
        edgeIds.add(validated.value.edge_id);
        validatedEdges.push(validated.value);
      }

      const result = await MappingEdge.importData(validatedNodes, validatedEdges);
      return res.json(createResponse(req.t('mapping.imported', {
        nodes: result.createdNodes,
        edges: result.createdEdges
      }), result));
    } catch (error) {
      console.error('Import mapping data error:', error);
      return res.status(500).json(createErrorResponse(req.t('mapping.importFailed'), error.message));
    }
  }

  static async resetMappingData(req, res) {
    try {
      const { password } = req.body;
      
      if (!password) {
        return res.status(400).json(
          createErrorResponse(req.t('mapping.passwordRequired'))
        );
      }

      const user = await User.findById(req.user.userId);
      
      if (!user || user.role !== 'admin') {
        return res.status(403).json(
          createErrorResponse(req.t('auth.insufficientPermissions'))
        );
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      
      if (!isPasswordValid) {
        return res.status(400).json(
          createErrorResponse(req.t('mapping.invalidPassword'))
        );
      }

      await MappingEdge.resetAll();
      
      return res.json(
        createResponse(req.t('mapping.reset'))
      );
    } catch (error) {
      console.error('Reset mapping data error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapping.resetFailed'), error.message)
      );
    }
  }
}

export default MappingController;

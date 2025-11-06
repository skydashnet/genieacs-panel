import express from 'express';
import MappingController from '../controllers/mappingController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/nodes', authenticateToken, MappingController.getAllNodes);

router.get('/nodes/:nodeId', authenticateToken, MappingController.getNodeByNodeId);

router.post('/nodes', authenticateToken, requireRole(['admin']), MappingController.createNode);

router.put('/nodes/:nodeId', authenticateToken, requireRole(['admin']), MappingController.updateNode);

router.delete('/nodes/:nodeId', authenticateToken, requireRole(['admin']), MappingController.deleteNode);

router.get('/edges', authenticateToken, MappingController.getAllEdges);

router.get('/edges/:edgeId', authenticateToken, MappingController.getEdgeByEdgeId);

router.post('/edges', authenticateToken, requireRole(['admin']), MappingController.createEdge);

router.put('/edges/:edgeId', authenticateToken, requireRole(['admin']), MappingController.updateEdge);

router.delete('/edges/:edgeId', authenticateToken, requireRole(['admin']), MappingController.deleteEdge);

router.post('/sync', authenticateToken, requireRole(['admin']), MappingController.syncMappingData);

router.delete('/reset', authenticateToken, requireRole(['admin']), MappingController.resetMappingData);

export default router;
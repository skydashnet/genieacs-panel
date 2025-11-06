import express from 'express';
import sqlite3 from 'sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'database.sqlite');

const router = express.Router();

/**
 * Mapping Data API Endpoints
 * Manage network mapping nodes and edges (fiber connections)
 */

// ============================================
// NODES ENDPOINTS
// ============================================

// GET /api/mapping-data/nodes - Get all nodes
router.get('/nodes', (req, res) => {
  const db = new sqlite3.Database(dbPath);
  db.all('SELECT * FROM mapping_nodes ORDER BY created_at DESC', [], (err, rows) => {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else {
      res.json({ success: true, data: rows });
    }
  });
});

// GET /api/mapping-data/nodes/:nodeId - Get single node by node_id
router.get('/nodes/:nodeId', (req, res) => {
  const { nodeId } = req.params;
  const db = new sqlite3.Database(dbPath);
  
  db.get('SELECT * FROM mapping_nodes WHERE node_id = ?', [nodeId], (err, row) => {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else if (!row) {
      res.status(404).json({ success: false, message: 'Node not found' });
    } else {
      res.json({ success: true, data: row });
    }
  });
});

// POST /api/mapping-data/nodes - Create new node
router.post('/nodes', (req, res) => {
  const { node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes } = req.body;

  if (!node_id || !type || !name || latitude === undefined || longitude === undefined) {
    return res.status(400).json({
      success: false,
      message: 'Required fields: node_id, type, name, latitude, longitude'
    });
  }

  // Validate type
  if (!['server', 'odc', 'odp', 'ont'].includes(type)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid type. Must be: server, odc, odp, or ont'
    });
  }

  const db = new sqlite3.Database(dbPath);
  
  db.run(
    `INSERT INTO mapping_nodes (node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes],
    function(err) {
      if (err) {
        db.close();
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(409).json({ success: false, message: 'Node ID already exists' });
        }
        return res.status(500).json({ success: false, message: 'Failed to create node', error: err.message });
      }
      
      // Get the inserted node
      db.get('SELECT * FROM mapping_nodes WHERE id = ?', [this.lastID], (err, row) => {
        db.close();
        if (err) {
          res.status(500).json({ success: false, message: 'Node created but error retrieving data', error: err.message });
        } else {
          res.status(201).json({ success: true, message: 'Node created successfully', data: row });
        }
      });
    }
  );
});

// PUT /api/mapping-data/nodes/:nodeId - Update node
router.put('/nodes/:nodeId', (req, res) => {
  const { nodeId } = req.params;
  const { name, latitude, longitude, capacity, splitter, pppoe, notes } = req.body;

  const db = new sqlite3.Database(dbPath);
  
  db.run(
    `UPDATE mapping_nodes SET 
      name = COALESCE(?, name),
      latitude = COALESCE(?, latitude),
      longitude = COALESCE(?, longitude),
      capacity = COALESCE(?, capacity),
      splitter = COALESCE(?, splitter),
      pppoe = COALESCE(?, pppoe),
      notes = COALESCE(?, notes),
      updated_at = CURRENT_TIMESTAMP
    WHERE node_id = ?`,
    [name, latitude, longitude, capacity, splitter, pppoe, notes, nodeId],
    function(err) {
      if (err) {
        db.close();
        return res.status(500).json({ success: false, message: 'Failed to update node', error: err.message });
      }
      
      if (this.changes === 0) {
        db.close();
        return res.status(404).json({ success: false, message: 'Node not found' });
      }
      
      // Get the updated node
      db.get('SELECT * FROM mapping_nodes WHERE node_id = ?', [nodeId], (err, row) => {
        db.close();
        if (err) {
          res.status(500).json({ success: false, message: 'Node updated but error retrieving data', error: err.message });
        } else {
          res.json({ success: true, message: 'Node updated successfully', data: row });
        }
      });
    }
  );
});

// DELETE /api/mapping-data/nodes/:nodeId - Delete node
router.delete('/nodes/:nodeId', (req, res) => {
  const { nodeId } = req.params;
  const db = new sqlite3.Database(dbPath);
  
  db.run('DELETE FROM mapping_nodes WHERE node_id = ?', [nodeId], function(err) {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Failed to delete node', error: err.message });
    } else if (this.changes === 0) {
      res.status(404).json({ success: false, message: 'Node not found' });
    } else {
      res.json({ success: true, message: 'Node deleted successfully' });
    }
  });
});

// ============================================
// EDGES ENDPOINTS
// ============================================

// GET /api/mapping-data/edges - Get all edges
router.get('/edges', (req, res) => {
  const db = new sqlite3.Database(dbPath);
  db.all('SELECT * FROM mapping_edges ORDER BY created_at DESC', [], (err, rows) => {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else {
      res.json({ success: true, data: rows });
    }
  });
});

// GET /api/mapping-data/edges/:edgeId - Get single edge by edge_id
router.get('/edges/:edgeId', (req, res) => {
  const { edgeId } = req.params;
  const db = new sqlite3.Database(dbPath);
  
  db.get('SELECT * FROM mapping_edges WHERE edge_id = ?', [edgeId], (err, row) => {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else if (!row) {
      res.status(404).json({ success: false, message: 'Edge not found' });
    } else {
      res.json({ success: true, data: row });
    }
  });
});

// POST /api/mapping-data/edges - Create new edge
router.post('/edges', (req, res) => {
  const { edge_id, source, target, fiber_type, distance, waypoints, notes } = req.body;

  if (!edge_id || !source || !target) {
    return res.status(400).json({
      success: false,
      message: 'Required fields: edge_id, source, target'
    });
  }

  // Validate fiber_type if provided
  if (fiber_type && !['feeder', 'distribution', 'drop'].includes(fiber_type)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid fiber_type. Must be: feeder, distribution, or drop'
    });
  }

  // Convert waypoints array to JSON string if provided
  const waypointsJson = waypoints ? JSON.stringify(waypoints) : null;

  const db = new sqlite3.Database(dbPath);
  
  db.run(
    `INSERT INTO mapping_edges (edge_id, source, target, fiber_type, distance, waypoints, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [edge_id, source, target, fiber_type, distance, waypointsJson, notes],
    function(err) {
      if (err) {
        db.close();
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(409).json({ success: false, message: 'Edge ID already exists' });
        }
        if (err.message.includes('FOREIGN KEY constraint failed')) {
          return res.status(400).json({ success: false, message: 'Source or target node does not exist' });
        }
        return res.status(500).json({ success: false, message: 'Failed to create edge', error: err.message });
      }
      
      // Get the inserted edge
      db.get('SELECT * FROM mapping_edges WHERE id = ?', [this.lastID], (err, row) => {
        db.close();
        if (err) {
          res.status(500).json({ success: false, message: 'Edge created but error retrieving data', error: err.message });
        } else {
          res.status(201).json({ success: true, message: 'Edge created successfully', data: row });
        }
      });
    }
  );
});

// PUT /api/mapping-data/edges/:edgeId - Update edge
router.put('/edges/:edgeId', (req, res) => {
  const { edgeId } = req.params;
  const { fiber_type, distance, waypoints, notes } = req.body;

  // Convert waypoints array to JSON string if provided
  const waypointsJson = waypoints ? JSON.stringify(waypoints) : undefined;

  const db = new sqlite3.Database(dbPath);
  
  db.run(
    `UPDATE mapping_edges SET 
      fiber_type = COALESCE(?, fiber_type),
      distance = COALESCE(?, distance),
      waypoints = COALESCE(?, waypoints),
      notes = COALESCE(?, notes),
      updated_at = CURRENT_TIMESTAMP
    WHERE edge_id = ?`,
    [fiber_type, distance, waypointsJson, notes, edgeId],
    function(err) {
      if (err) {
        db.close();
        return res.status(500).json({ success: false, message: 'Failed to update edge', error: err.message });
      }
      
      if (this.changes === 0) {
        db.close();
        return res.status(404).json({ success: false, message: 'Edge not found' });
      }
      
      // Get the updated edge
      db.get('SELECT * FROM mapping_edges WHERE edge_id = ?', [edgeId], (err, row) => {
        db.close();
        if (err) {
          res.status(500).json({ success: false, message: 'Edge updated but error retrieving data', error: err.message });
        } else {
          res.json({ success: true, message: 'Edge updated successfully', data: row });
        }
      });
    }
  );
});

// DELETE /api/mapping-data/edges/:edgeId - Delete edge
router.delete('/edges/:edgeId', (req, res) => {
  const { edgeId } = req.params;
  const db = new sqlite3.Database(dbPath);
  
  db.run('DELETE FROM mapping_edges WHERE edge_id = ?', [edgeId], function(err) {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Failed to delete edge', error: err.message });
    } else if (this.changes === 0) {
      res.status(404).json({ success: false, message: 'Edge not found' });
    } else {
      res.json({ success: true, message: 'Edge deleted successfully' });
    }
  });
});

// ============================================
// BULK SYNC ENDPOINT
// ============================================

// POST /api/mapping-data/sync - Sync all mapping data (replace all)
router.post('/sync', (req, res) => {
  const { nodes, edges } = req.body;

  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid data format. Expected { nodes: [], edges: [] }'
    });
  }

  const db = new sqlite3.Database(dbPath);
  
  db.serialize(() => {
    // Start transaction
    db.run('BEGIN TRANSACTION');

    // Delete all existing data
    db.run('DELETE FROM mapping_edges', (err) => {
      if (err) {
        db.run('ROLLBACK');
        db.close();
        return res.status(500).json({ success: false, message: 'Failed to clear edges', error: err.message });
      }

      db.run('DELETE FROM mapping_nodes', (err) => {
        if (err) {
          db.run('ROLLBACK');
          db.close();
          return res.status(500).json({ success: false, message: 'Failed to clear nodes', error: err.message });
        }

        // Insert nodes
        const insertNodeStmt = db.prepare(
          `INSERT INTO mapping_nodes (node_id, type, name, latitude, longitude, capacity, splitter, pppoe, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        let nodeErrors = 0;
        nodes.forEach(node => {
          insertNodeStmt.run(
            node.node_id,
            node.type,
            node.name,
            node.latitude,
            node.longitude,
            node.capacity,
            node.splitter,
            node.pppoe,
            node.notes,
            (err) => {
              if (err) nodeErrors++;
            }
          );
        });

        insertNodeStmt.finalize(() => {
          if (nodeErrors > 0) {
            db.run('ROLLBACK');
            db.close();
            return res.status(500).json({ success: false, message: `Failed to insert ${nodeErrors} nodes` });
          }

          // Insert edges
          const insertEdgeStmt = db.prepare(
            `INSERT INTO mapping_edges (edge_id, source, target, fiber_type, distance, waypoints, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)`
          );

          let edgeErrors = 0;
          edges.forEach(edge => {
            const waypointsJson = edge.waypoints ? JSON.stringify(edge.waypoints) : null;
            insertEdgeStmt.run(
              edge.edge_id,
              edge.source,
              edge.target,
              edge.fiber_type,
              edge.distance,
              waypointsJson,
              edge.notes,
              (err) => {
                if (err) edgeErrors++;
              }
            );
          });

          insertEdgeStmt.finalize(() => {
            if (edgeErrors > 0) {
              db.run('ROLLBACK');
              db.close();
              return res.status(500).json({ success: false, message: `Failed to insert ${edgeErrors} edges` });
            }

            // Commit transaction
            db.run('COMMIT', (err) => {
              db.close();
              if (err) {
                return res.status(500).json({ success: false, message: 'Failed to commit transaction', error: err.message });
              }
              res.json({
                success: true,
                message: 'Mapping data synchronized successfully',
                summary: {
                  nodes: nodes.length,
                  edges: edges.length
                }
              });
            });
          });
        });
      });
    });
  });
});

// DELETE /api/mapping-data/reset - Delete all mapping data (requires password)
router.delete('/reset', (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({
      success: false,
      message: 'Password is required'
    });
  }

  // Get user credentials from session/token to verify password
  // For now, we'll get the username from the token (you should decode JWT token)
  // This is a simplified version - in production, decode the JWT token properly
  const db = new sqlite3.Database(dbPath);

  // Get current user from authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    db.close();
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  // For simplicity, we'll verify against admin user
  // In production, decode JWT and get username from token
  db.get('SELECT * FROM users WHERE role = ? LIMIT 1', ['admin'], async (err, user) => {
    if (err || !user) {
      db.close();
      return res.status(500).json({ success: false, message: 'Failed to verify user' });
    }

    // Verify password using bcrypt
    try {
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        db.close();
        // Use 400 instead of 401 to prevent auto-logout on wrong password
        return res.status(400).json({ success: false, message: 'Invalid password. Please try again.' });
      }

      // Password verified, proceed to delete all mapping data
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Delete all edges first (foreign key constraint)
        db.run('DELETE FROM mapping_edges', (err) => {
          if (err) {
            db.run('ROLLBACK');
            db.close();
            return res.status(500).json({ success: false, message: 'Failed to delete edges', error: err.message });
          }

          // Delete all nodes
          db.run('DELETE FROM mapping_nodes', (err) => {
            if (err) {
              db.run('ROLLBACK');
              db.close();
              return res.status(500).json({ success: false, message: 'Failed to delete nodes', error: err.message });
            }

            // Commit transaction
            db.run('COMMIT', (err) => {
              db.close();
              if (err) {
                return res.status(500).json({ success: false, message: 'Failed to commit transaction', error: err.message });
              }
              res.json({
                success: true,
                message: 'All mapping data has been deleted successfully'
              });
            });
          });
        });
      });
    } catch (error) {
      db.close();
      return res.status(500).json({ success: false, message: 'Failed to verify password' });
    }
  });
});

export default router;

import express from 'express';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'database.sqlite');

const router = express.Router();

/**
 * Vendor Management API Endpoints
 * CRUD operations for vendors, sub-types, parameters, and WiFi security mappings
 */

// ============================================
// VENDORS
// ============================================

// GET /api/vendor-management/vendors - Get all vendors
router.get('/vendors', (req, res) => {
  const db = new sqlite3.Database(dbPath);
  db.all('SELECT * FROM vendors ORDER BY priority DESC, name ASC', [], (err, rows) => {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else {
      const vendors = rows.map(row => {
        // Safely parse patterns - handle both JSON and plain string
        let mfrPatterns = [];
        let prodPatterns = [];
        
        try {
          if (row.manufacturer_patterns) {
            const parsed = JSON.parse(row.manufacturer_patterns);
            mfrPatterns = Array.isArray(parsed) ? parsed : [parsed];
          }
        } catch (e) {
          // If not JSON, treat as comma-separated string
          mfrPatterns = row.manufacturer_patterns ? row.manufacturer_patterns.split(',').map(s => s.trim()) : [];
        }
        
        try {
          if (row.product_patterns) {
            const parsed = JSON.parse(row.product_patterns);
            prodPatterns = Array.isArray(parsed) ? parsed : [parsed];
          }
        } catch (e) {
          // If not JSON, treat as comma-separated string
          prodPatterns = row.product_patterns ? row.product_patterns.split(',').map(s => s.trim()) : [];
        }
        
        return {
          ...row,
          manufacturer_patterns: mfrPatterns,
          product_patterns: prodPatterns
        };
      });
      res.json({ success: true, data: vendors });
    }
  });
});

// POST /api/vendor-management/vendors - Create new vendor (SIMPLIFIED!)
router.post('/vendors', (req, res) => {
  const {
    name, manufacturer_patterns, product_patterns, parameter_prefix,
    service_list_path, lan_binding_path, vlan_id_path, wifi_password_path,
    http_wan_enable_path, firewall_level_path,
    priority, enabled, description
  } = req.body;

  if (!name || !manufacturer_patterns || !product_patterns) {
    return res.status(400).json({ success: false, message: 'Name, manufacturer_patterns, and product_patterns are required' });
  }

  const db = new sqlite3.Database(dbPath);
  db.run(
    `INSERT INTO vendors (
      name, manufacturer_patterns, product_patterns, parameter_prefix,
      service_list_path, lan_binding_path, vlan_id_path, wifi_password_path,
      http_wan_enable_path, firewall_level_path,
      priority, enabled, description
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      // Convert patterns to JSON array - handle string (comma-separated) or array input
      typeof manufacturer_patterns === 'string' 
        ? JSON.stringify(manufacturer_patterns.split(',').map(s => s.trim()).filter(s => s))
        : JSON.stringify(manufacturer_patterns),
      typeof product_patterns === 'string' 
        ? JSON.stringify(product_patterns.split(',').map(s => s.trim()).filter(s => s))
        : JSON.stringify(product_patterns),
      parameter_prefix || null,
      service_list_path || null,
      lan_binding_path || null,
      vlan_id_path || null,
      wifi_password_path || null,
      http_wan_enable_path || null,
      firewall_level_path || null,
      priority || 10,
      enabled !== undefined ? enabled : 1,
      description || null
    ],
    function(err) {
      db.close();
      if (err) {
        res.status(500).json({ success: false, message: 'Failed to create vendor', error: err.message });
      } else {
        res.json({ success: true, message: 'Vendor created successfully', id: this.lastID });
      }
    }
  );
});

// PUT /api/vendor-management/vendors/:id - Update vendor (SIMPLIFIED!)
router.put('/vendors/:id', (req, res) => {
  const { id } = req.params;
  const {
    name, manufacturer_patterns, product_patterns, parameter_prefix,
    service_list_path, lan_binding_path, vlan_id_path, wifi_password_path,
    http_wan_enable_path, firewall_level_path,
    priority, enabled, description
  } = req.body;

  const db = new sqlite3.Database(dbPath);
  db.run(
    `UPDATE vendors SET 
      name = COALESCE(?, name),
      manufacturer_patterns = COALESCE(?, manufacturer_patterns),
      product_patterns = COALESCE(?, product_patterns),
      parameter_prefix = COALESCE(?, parameter_prefix),
      service_list_path = COALESCE(?, service_list_path),
      lan_binding_path = COALESCE(?, lan_binding_path),
      vlan_id_path = COALESCE(?, vlan_id_path),
      wifi_password_path = COALESCE(?, wifi_password_path),
      http_wan_enable_path = COALESCE(?, http_wan_enable_path),
      firewall_level_path = COALESCE(?, firewall_level_path),
      priority = COALESCE(?, priority),
      enabled = COALESCE(?, enabled),
      description = COALESCE(?, description),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
    [
      name || null,
      manufacturer_patterns 
        ? (typeof manufacturer_patterns === 'string' 
            ? JSON.stringify(manufacturer_patterns.split(',').map(s => s.trim()).filter(s => s))
            : JSON.stringify(manufacturer_patterns))
        : null,
      product_patterns 
        ? (typeof product_patterns === 'string' 
            ? JSON.stringify(product_patterns.split(',').map(s => s.trim()).filter(s => s))
            : JSON.stringify(product_patterns))
        : null,
      parameter_prefix !== undefined ? parameter_prefix : null,
      service_list_path !== undefined ? service_list_path : null,
      lan_binding_path !== undefined ? lan_binding_path : null,
      vlan_id_path !== undefined ? vlan_id_path : null,
      wifi_password_path !== undefined ? wifi_password_path : null,
      http_wan_enable_path !== undefined ? http_wan_enable_path : null,
      firewall_level_path !== undefined ? firewall_level_path : null,
      priority !== undefined ? priority : null,
      enabled !== undefined ? enabled : null,
      description !== undefined ? description : null,
      id
    ],
    function(err) {
      db.close();
      if (err) {
        res.status(500).json({ success: false, message: 'Failed to update vendor', error: err.message });
      } else if (this.changes === 0) {
        res.status(404).json({ success: false, message: 'Vendor not found' });
      } else {
        res.json({ success: true, message: 'Vendor updated successfully' });
      }
    }
  );
});

// DELETE /api/vendor-management/vendors/:id - Delete vendor
router.delete('/vendors/:id', (req, res) => {
  const { id } = req.params;

  const db = new sqlite3.Database(dbPath);
  db.run('DELETE FROM vendors WHERE id = ?', [id], function(err) {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Failed to delete vendor', error: err.message });
    } else if (this.changes === 0) {
      res.status(404).json({ success: false, message: 'Vendor not found' });
    } else {
      res.json({ success: true, message: 'Vendor deleted successfully' });
    }
  });
});

// ============================================
// VENDOR SUB-TYPES
// ============================================

// GET /api/vendor-management/sub-types/:vendorId - Get all sub-types for a vendor
router.get('/sub-types/:vendorId', (req, res) => {
  const { vendorId } = req.params;

  const db = new sqlite3.Database(dbPath);
  db.all(
    'SELECT * FROM vendor_sub_types WHERE vendor_id = ? ORDER BY priority DESC, sub_type_name ASC',
    [vendorId],
    (err, rows) => {
      db.close();
      if (err) {
        res.status(500).json({ success: false, message: 'Database error', error: err.message });
      } else {
        const subTypes = rows.map(row => ({
          ...row,
          detection_patterns: JSON.parse(row.detection_patterns || '{}')
        }));
        res.json({ success: true, data: subTypes });
      }
    }
  );
});

// POST /api/vendor-management/sub-types - Create new sub-type
router.post('/sub-types', (req, res) => {
  const { vendor_id, sub_type_name, detection_patterns, parameter_prefix, priority, enabled, description } = req.body;

  if (!vendor_id || !sub_type_name) {
    return res.status(400).json({ success: false, message: 'vendor_id and sub_type_name are required' });
  }

  const db = new sqlite3.Database(dbPath);
  db.run(
    'INSERT INTO vendor_sub_types (vendor_id, sub_type_name, detection_patterns, parameter_prefix, priority, enabled, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      vendor_id,
      sub_type_name,
      JSON.stringify(detection_patterns || {}),
      parameter_prefix || null,
      priority || 10,
      enabled !== undefined ? enabled : 1,
      description || null
    ],
    function(err) {
      db.close();
      if (err) {
        res.status(500).json({ success: false, message: 'Failed to create sub-type', error: err.message });
      } else {
        res.json({ success: true, message: 'Sub-type created successfully', id: this.lastID });
      }
    }
  );
});

// PUT /api/vendor-management/sub-types/:id - Update sub-type
router.put('/sub-types/:id', (req, res) => {
  const { id } = req.params;
  const { sub_type_name, detection_patterns, parameter_prefix, priority, enabled, description } = req.body;

  const db = new sqlite3.Database(dbPath);
  db.run(
    `UPDATE vendor_sub_types SET 
      sub_type_name = COALESCE(?, sub_type_name),
      detection_patterns = COALESCE(?, detection_patterns),
      parameter_prefix = COALESCE(?, parameter_prefix),
      priority = COALESCE(?, priority),
      enabled = COALESCE(?, enabled),
      description = COALESCE(?, description),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
    [
      sub_type_name || null,
      detection_patterns ? JSON.stringify(detection_patterns) : null,
      parameter_prefix !== undefined ? parameter_prefix : null,
      priority !== undefined ? priority : null,
      enabled !== undefined ? enabled : null,
      description !== undefined ? description : null,
      id
    ],
    function(err) {
      db.close();
      if (err) {
        res.status(500).json({ success: false, message: 'Failed to update sub-type', error: err.message });
      } else if (this.changes === 0) {
        res.status(404).json({ success: false, message: 'Sub-type not found' });
      } else {
        res.json({ success: true, message: 'Sub-type updated successfully' });
      }
    }
  );
});

// DELETE /api/vendor-management/sub-types/:id - Delete sub-type
router.delete('/sub-types/:id', (req, res) => {
  const { id } = req.params;

  const db = new sqlite3.Database(dbPath);
  db.run('DELETE FROM vendor_sub_types WHERE id = ?', [id], function(err) {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Failed to delete sub-type', error: err.message });
    } else if (this.changes === 0) {
      res.status(404).json({ success: false, message: 'Sub-type not found' });
    } else {
      res.json({ success: true, message: 'Sub-type deleted successfully' });
    }
  });
});

// ============================================
// VENDOR PARAMETERS
// ============================================

// GET /api/vendor-management/parameters/:vendorId - Get all parameters for a vendor
router.get('/parameters/:vendorId', (req, res) => {
  const { vendorId } = req.params;
  const { category, sub_type_id } = req.query;

  let query = 'SELECT * FROM vendor_parameters WHERE vendor_id = ?';
  const params = [vendorId];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  if (sub_type_id) {
    query += ' AND (sub_type_id = ? OR sub_type_id IS NULL)';
    params.push(sub_type_id);
  }

  query += ' ORDER BY category ASC, priority DESC, param_name ASC';

  const db = new sqlite3.Database(dbPath);
  db.all(query, params, (err, rows) => {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else {
      res.json({ success: true, data: rows });
    }
  });
});

// POST /api/vendor-management/parameters - Create new parameter
router.post('/parameters', (req, res) => {
  const { vendor_id, sub_type_id, category, param_name, parameter_path, priority, enabled, fallback_to_null, description } = req.body;

  if (!vendor_id || !category || !param_name || !parameter_path) {
    return res.status(400).json({ success: false, message: 'vendor_id, category, param_name, and parameter_path are required' });
  }

  const db = new sqlite3.Database(dbPath);
  db.run(
    'INSERT INTO vendor_parameters (vendor_id, sub_type_id, category, param_name, parameter_path, priority, enabled, fallback_to_null, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      vendor_id,
      sub_type_id || null,
      category,
      param_name,
      parameter_path,
      priority || 10,
      enabled !== undefined ? enabled : 1,
      fallback_to_null !== undefined ? fallback_to_null : 0,
      description || null
    ],
    function(err) {
      db.close();
      if (err) {
        res.status(500).json({ success: false, message: 'Failed to create parameter', error: err.message });
      } else {
        res.json({ success: true, message: 'Parameter created successfully', id: this.lastID });
      }
    }
  );
});

// PUT /api/vendor-management/parameters/:id - Update parameter
router.put('/parameters/:id', (req, res) => {
  const { id } = req.params;
  const { category, param_name, parameter_path, priority, enabled, fallback_to_null, description } = req.body;

  const db = new sqlite3.Database(dbPath);
  db.run(
    `UPDATE vendor_parameters SET 
      category = COALESCE(?, category),
      param_name = COALESCE(?, param_name),
      parameter_path = COALESCE(?, parameter_path),
      priority = COALESCE(?, priority),
      enabled = COALESCE(?, enabled),
      fallback_to_null = COALESCE(?, fallback_to_null),
      description = COALESCE(?, description),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
    [
      category || null,
      param_name || null,
      parameter_path || null,
      priority !== undefined ? priority : null,
      enabled !== undefined ? enabled : null,
      fallback_to_null !== undefined ? fallback_to_null : null,
      description !== undefined ? description : null,
      id
    ],
    function(err) {
      db.close();
      if (err) {
        res.status(500).json({ success: false, message: 'Failed to update parameter', error: err.message });
      } else if (this.changes === 0) {
        res.status(404).json({ success: false, message: 'Parameter not found' });
      } else {
        res.json({ success: true, message: 'Parameter updated successfully' });
      }
    }
  );
});

// DELETE /api/vendor-management/parameters/:id - Delete parameter
router.delete('/parameters/:id', (req, res) => {
  const { id } = req.params;

  const db = new sqlite3.Database(dbPath);
  db.run('DELETE FROM vendor_parameters WHERE id = ?', [id], function(err) {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Failed to delete parameter', error: err.message });
    } else if (this.changes === 0) {
      res.status(404).json({ success: false, message: 'Parameter not found' });
    } else {
      res.json({ success: true, message: 'Parameter deleted successfully' });
    }
  });
});

// ============================================
// WIFI SECURITY MAPPINGS
// ============================================

// GET /api/vendor-management/wifi-security/:vendorId - Get all WiFi security mappings for a vendor
router.get('/wifi-security/:vendorId', (req, res) => {
  const { vendorId } = req.params;

  const db = new sqlite3.Database(dbPath);
  db.all(
    'SELECT * FROM wifi_security_mappings WHERE vendor_id = ? ORDER BY raw_security_value ASC',
    [vendorId],
    (err, rows) => {
      db.close();
      if (err) {
        res.status(500).json({ success: false, message: 'Database error', error: err.message });
      } else {
        res.json({ success: true, data: rows });
      }
    }
  );
});

// POST /api/vendor-management/wifi-security - Create new WiFi security mapping
router.post('/wifi-security', (req, res) => {
  const { vendor_id, raw_security_value, normalized_security, description } = req.body;

  if (!vendor_id || !raw_security_value || !normalized_security) {
    return res.status(400).json({ success: false, message: 'vendor_id, raw_security_value, and normalized_security are required' });
  }

  const db = new sqlite3.Database(dbPath);
  db.run(
    'INSERT INTO wifi_security_mappings (vendor_id, raw_security_value, normalized_security, description) VALUES (?, ?, ?, ?)',
    [vendor_id, raw_security_value, normalized_security, description || null],
    function(err) {
      db.close();
      if (err) {
        res.status(500).json({ success: false, message: 'Failed to create WiFi security mapping', error: err.message });
      } else {
        res.json({ success: true, message: 'WiFi security mapping created successfully', id: this.lastID });
      }
    }
  );
});

// PUT /api/vendor-management/wifi-security/:id - Update WiFi security mapping
router.put('/wifi-security/:id', (req, res) => {
  const { id } = req.params;
  const { raw_security_value, normalized_security, description } = req.body;

  const db = new sqlite3.Database(dbPath);
  db.run(
    `UPDATE wifi_security_mappings SET 
      raw_security_value = COALESCE(?, raw_security_value),
      normalized_security = COALESCE(?, normalized_security),
      description = COALESCE(?, description),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
    [
      raw_security_value || null,
      normalized_security || null,
      description !== undefined ? description : null,
      id
    ],
    function(err) {
      db.close();
      if (err) {
        res.status(500).json({ success: false, message: 'Failed to update WiFi security mapping', error: err.message });
      } else if (this.changes === 0) {
        res.status(404).json({ success: false, message: 'WiFi security mapping not found' });
      } else {
        res.json({ success: true, message: 'WiFi security mapping updated successfully' });
      }
    }
  );
});

// DELETE /api/vendor-management/wifi-security/:id - Delete WiFi security mapping
router.delete('/wifi-security/:id', (req, res) => {
  const { id } = req.params;

  const db = new sqlite3.Database(dbPath);
  db.run('DELETE FROM wifi_security_mappings WHERE id = ?', [id], function(err) {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Failed to delete WiFi security mapping', error: err.message });
    } else if (this.changes === 0) {
      res.status(404).json({ success: false, message: 'WiFi security mapping not found' });
    } else {
      res.json({ success: true, message: 'WiFi security mapping deleted successfully' });
    }
  });
});

// ============================================
// WIFI SECURITY CONFIG
// ============================================

// GET /api/vendor-management/wifi-security-config - Get all WiFi security configurations
router.get('/wifi-security-config', (req, res) => {
  const db = new sqlite3.Database(dbPath);
  db.all('SELECT * FROM wifi_security_config ORDER BY product_class ASC', [], (err, rows) => {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else {
      const configs = rows.map(row => ({
        ...row,
        security_types_array: row.security_types ? row.security_types.split(',') : []
      }));
      res.json({ success: true, data: configs });
    }
  });
});

// GET /api/vendor-management/wifi-security-config/:id - Get WiFi security config by ID
router.get('/wifi-security-config/:id', (req, res) => {
  const { id } = req.params;
  const db = new sqlite3.Database(dbPath);
  db.get('SELECT * FROM wifi_security_config WHERE id = ?', [id], (err, row) => {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else if (!row) {
      res.status(404).json({ success: false, message: 'WiFi security config not found' });
    } else {
      const config = {
        ...row,
        security_types_array: row.security_types ? row.security_types.split(',') : []
      };
      res.json({ success: true, data: config });
    }
  });
});

// GET /api/vendor-management/wifi-security-config/by-product-class/:productClass - Get WiFi security config by product class
router.get('/wifi-security-config/by-product-class/:productClass', (req, res) => {
  const { productClass } = req.params;
  const db = new sqlite3.Database(dbPath);
  db.get('SELECT * FROM wifi_security_config WHERE LOWER(product_class) = LOWER(?)', [productClass], (err, row) => {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else if (!row) {
      res.status(404).json({ success: false, message: 'WiFi security config not found for product class' });
    } else {
      const config = {
        ...row,
        security_types_array: row.security_types ? row.security_types.split(',') : []
      };
      res.json({ success: true, data: config });
    }
  });
});

// POST /api/vendor-management/wifi-security-config - Create new WiFi security config
router.post('/wifi-security-config', (req, res) => {
  const { product_class, security_types, password_param_path } = req.body;

  if (!product_class || !security_types || !password_param_path) {
    return res.status(400).json({ success: false, message: 'Product class, security types, and password parameter path are required' });
  }

  // Convert array to comma-separated string if needed
  const securityTypesString = Array.isArray(security_types) ? security_types.join(',') : security_types;

  const db = new sqlite3.Database(dbPath);
  db.run(
    'INSERT INTO wifi_security_config (product_class, security_types, password_param_path) VALUES (?, ?, ?)',
    [product_class, securityTypesString, password_param_path],
    function(err) {
      if (err) {
        db.close();
        if (err.code === 'SQLITE_CONSTRAINT') {
          res.status(409).json({ success: false, message: 'WiFi security config for this product class already exists' });
        } else {
          res.status(500).json({ success: false, message: 'Database error', error: err.message });
        }
      } else {
        // Get the created config
        db.get('SELECT * FROM wifi_security_config WHERE id = ?', [this.lastID], (err, row) => {
          db.close();
          if (err) {
            res.status(500).json({ success: false, message: 'Config created but error retrieving data', error: err.message });
          } else {
            const config = {
              ...row,
              security_types_array: row.security_types ? row.security_types.split(',') : []
            };
            res.status(201).json({ success: true, message: 'WiFi security config created successfully', data: config });
          }
        });
      }
    }
  );
});

// PUT /api/vendor-management/wifi-security-config/:id - Update WiFi security config
router.put('/wifi-security-config/:id', (req, res) => {
  const { id } = req.params;
  const { product_class, security_types, password_param_path } = req.body;

  if (!product_class || !security_types || !password_param_path) {
    return res.status(400).json({ success: false, message: 'Product class, security types, and password parameter path are required' });
  }

  // Convert array to comma-separated string if needed
  const securityTypesString = Array.isArray(security_types) ? security_types.join(',') : security_types;

  const db = new sqlite3.Database(dbPath);
  db.run(
    'UPDATE wifi_security_config SET product_class = ?, security_types = ?, password_param_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [product_class, securityTypesString, password_param_path, id],
    function(err) {
      if (err) {
        db.close();
        if (err.code === 'SQLITE_CONSTRAINT') {
          res.status(409).json({ success: false, message: 'WiFi security config for this product class already exists' });
        } else {
          res.status(500).json({ success: false, message: 'Database error', error: err.message });
        }
      } else if (this.changes === 0) {
        db.close();
        res.status(404).json({ success: false, message: 'WiFi security config not found' });
      } else {
        // Get the updated config
        db.get('SELECT * FROM wifi_security_config WHERE id = ?', [id], (err, row) => {
          db.close();
          if (err) {
            res.status(500).json({ success: false, message: 'Config updated but error retrieving data', error: err.message });
          } else {
            const config = {
              ...row,
              security_types_array: row.security_types ? row.security_types.split(',') : []
            };
            res.json({ success: true, message: 'WiFi security config updated successfully', data: config });
          }
        });
      }
    }
  );
});

// DELETE /api/vendor-management/wifi-security-config/:id - Delete WiFi security config
router.delete('/wifi-security-config/:id', (req, res) => {
  const { id } = req.params;
  const db = new sqlite3.Database(dbPath);
  db.run('DELETE FROM wifi_security_config WHERE id = ?', [id], function(err) {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else if (this.changes === 0) {
      res.status(404).json({ success: false, message: 'WiFi security config not found' });
    } else {
      res.json({ success: true, message: 'WiFi security config deleted successfully' });
    }
  });
});

export default router;

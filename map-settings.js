import express from 'express';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'database.sqlite');

const router = express.Router();

/**
 * Map Settings API Endpoints
 * Manage map configuration (center coordinates and zoom levels)
 */

// GET /api/map-settings - Get current map settings
router.get('/', (req, res) => {
  const db = new sqlite3.Database(dbPath);
  db.get('SELECT * FROM map_settings WHERE id = 1', [], (err, row) => {
    db.close();
    if (err) {
      res.status(500).json({ success: false, message: 'Database error', error: err.message });
    } else if (!row) {
      // Return default settings if not found
      res.json({
        success: true,
        data: {
          center_lat: '-6.2088',
          center_lng: '106.8456',
          max_zoom_in: '18',
          max_zoom_out: '5',
          default_zoom: '13'
        }
      });
    } else {
      res.json({ success: true, data: row });
    }
  });
});

// PUT /api/map-settings - Update map settings
router.put('/', (req, res) => {
  const { center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom } = req.body;

  if (!center_lat || !center_lng || !max_zoom_in || !max_zoom_out || !default_zoom) {
    return res.status(400).json({
      success: false,
      message: 'All fields are required: center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom'
    });
  }

  const db = new sqlite3.Database(dbPath);
  
  // Try to update first
  db.run(
    `UPDATE map_settings SET 
      center_lat = ?,
      center_lng = ?,
      max_zoom_in = ?,
      max_zoom_out = ?,
      default_zoom = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1`,
    [center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom],
    function(err) {
      if (err) {
        db.close();
        return res.status(500).json({ success: false, message: 'Failed to update map settings', error: err.message });
      }
      
      // If no rows updated, insert new record
      if (this.changes === 0) {
        db.run(
          `INSERT INTO map_settings (id, center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom)
          VALUES (1, ?, ?, ?, ?, ?)`,
          [center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom],
          function(err) {
            if (err) {
              db.close();
              return res.status(500).json({ success: false, message: 'Failed to insert map settings', error: err.message });
            }
            
            // Get the inserted/updated settings
            db.get('SELECT * FROM map_settings WHERE id = 1', [], (err, row) => {
              db.close();
              if (err) {
                res.status(500).json({ success: false, message: 'Settings saved but error retrieving data', error: err.message });
              } else {
                res.json({ success: true, message: 'Map settings saved successfully', data: row });
              }
            });
          }
        );
      } else {
        // Get the updated settings
        db.get('SELECT * FROM map_settings WHERE id = 1', [], (err, row) => {
          db.close();
          if (err) {
            res.status(500).json({ success: false, message: 'Settings updated but error retrieving data', error: err.message });
          } else {
            res.json({ success: true, message: 'Map settings updated successfully', data: row });
          }
        });
      }
    }
  );
});

// POST /api/map-settings/reset - Reset to default settings
router.post('/reset', (req, res) => {
  const db = new sqlite3.Database(dbPath);
  
  db.run(
    `UPDATE map_settings SET 
      center_lat = '-6.2088',
      center_lng = '106.8456',
      max_zoom_in = '18',
      max_zoom_out = '5',
      default_zoom = '13',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1`,
    [],
    function(err) {
      if (err) {
        db.close();
        return res.status(500).json({ success: false, message: 'Failed to reset map settings', error: err.message });
      }
      
      // Get the reset settings
      db.get('SELECT * FROM map_settings WHERE id = 1', [], (err, row) => {
        db.close();
        if (err) {
          res.status(500).json({ success: false, message: 'Settings reset but error retrieving data', error: err.message });
        } else {
          res.json({ success: true, message: 'Map settings reset to defaults', data: row });
        }
      });
    }
  );
});

export default router;

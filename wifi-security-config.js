import express from 'express';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Database setup
const dbPath = path.join(__dirname, 'database.sqlite');

/**
 * GET /api/wifi-security-config
 * Get security configuration for a specific product class
 * Query params: productClass
 */
router.get('/', (req, res) => {
  const { productClass } = req.query;

  if (!productClass) {
    return res.status(400).json({ 
      error: 'Product class is required',
      message: 'Please provide productClass query parameter'
    });
  }

  const db = new sqlite3.Database(dbPath);

  const query = `
    SELECT * FROM wifi_security_config 
    WHERE product_class = ? 
    LIMIT 1
  `;

  db.get(query, [productClass], (err, row) => {
    if (err) {
      console.error('Database error:', err);
      db.close();
      return res.status(500).json({ 
        error: 'Database error', 
        message: err.message 
      });
    }

    db.close();

    if (!row) {
      return res.status(404).json({ 
        error: 'Not found',
        message: `No security configuration found for product class: ${productClass}`
      });
    }

    // Return the configuration
    res.json(row);
  });
});

/**
 * GET /api/wifi-security-config/all
 * Get all security configurations
 */
router.get('/all', (req, res) => {
  const db = new sqlite3.Database(dbPath);

  const query = 'SELECT * FROM wifi_security_config ORDER BY product_class';

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      db.close();
      return res.status(500).json({ 
        error: 'Database error', 
        message: err.message 
      });
    }

    db.close();
    res.json(rows);
  });
});

export default router;

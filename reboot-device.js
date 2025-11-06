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
 * POST /api/reboot-device
 * Reboot a device via GenieACS
 * 
 * Body:
 * {
 *   deviceId: string
 * }
 */
router.post('/', async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ 
      error: 'Missing required field',
      message: 'deviceId is required'
    });
  }

  // Get GenieACS URL from database
  const db = new sqlite3.Database(dbPath);
  
  db.get('SELECT value FROM settings WHERE key = ?', ['genieAcsUrl'], async (err, row) => {
    if (err) {
      db.close();
      console.error('[Reboot Device] Database error:', err);
      return res.status(500).json({ 
        error: 'Database error',
        message: err.message
      });
    }

    if (!row || !row.value) {
      db.close();
      return res.status(500).json({ 
        error: 'GenieACS URL not configured',
        message: 'Please configure GenieACS URL in settings first'
      });
    }

    const baseUrl = row.value; // Already includes /devices
    db.close();

    try {

      // Build task payload for GenieACS reboot
      const taskPayload = {
        name: 'reboot'
      };

      // Create reboot task in GenieACS
      const taskUrl = `${baseUrl}/${encodeURIComponent(deviceId)}/tasks?timeout=3000&connection_request`;

      const response = await fetch(taskUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(taskPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Reboot Device] GenieACS error (${response.status}):`, errorText);
        throw new Error(`GenieACS returned ${response.status}: ${errorText}`);
      }

      const result = await response.json().catch(() => null);

      // Return success response
      res.json({
        success: true,
        message: 'Device reboot initiated successfully',
        deviceId,
        taskResponse: result
      });

    } catch (error) {
      console.error('[Reboot Device] Error initiating reboot:', error.message);
      
      res.status(500).json({
        error: 'Failed to reboot device',
        message: error.message,
        details: {
          deviceId
        }
      });
    }
  });
});

export default router;

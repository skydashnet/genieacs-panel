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
 * POST /api/credential-config/set-parameter
 * Set a single parameter value for credentials (username/password) in GenieACS
 * 
 * Body:
 * {
 *   deviceId: string,
 *   parameterPath: string,
 *   parameterValue: any,
 *   parameterType: string (optional, default: 'xsd:string')
 * }
 */
router.post('/set-parameter', async (req, res) => {
  const { deviceId, parameterPath, parameterValue, parameterType = 'xsd:string' } = req.body;

  if (!deviceId || !parameterPath || parameterValue === undefined) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      message: 'deviceId, parameterPath, and parameterValue are required'
    });
  }

  // Get GenieACS URL from database
  const db = new sqlite3.Database(dbPath);
  
  db.get('SELECT value FROM settings WHERE key = ?', ['genieAcsUrl'], async (err, row) => {
    if (err) {
      db.close();
      console.error('[Credential Config] Database error:', err);
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
      console.log(`[Credential Config] Setting credential parameter for device ${deviceId}`);
      console.log(`  Path: ${parameterPath}`);
      console.log(`  Value: ${parameterPath.includes('Password') ? '***' : parameterValue}`);
      console.log(`  Type: ${parameterType}`);

      // Build task payload for GenieACS
      const taskPayload = {
        name: 'setParameterValues',
        parameterValues: [[parameterPath, parameterValue, parameterType]]
      };

      // Create task in GenieACS
      const taskUrl = `${baseUrl}/${encodeURIComponent(deviceId)}/tasks?timeout=3000&connection_request`;
      console.log(`[Credential Config] Task URL: ${taskUrl}`);

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
        console.error(`[Credential Config] GenieACS error (${response.status}):`, errorText);
        throw new Error(`GenieACS returned ${response.status}: ${errorText}`);
      }

      const result = await response.json().catch(() => null);
      console.log(`[Credential Config] Task created successfully:`, result);

      // Return success response
      res.json({
        success: true,
        message: 'Credential parameter updated successfully',
        deviceId,
        parameterPath,
        taskResponse: result
      });

    } catch (error) {
      console.error('[Credential Config] Error setting credential parameter:', error.message);
      
      res.status(500).json({
        error: 'Failed to set credential parameter',
        message: error.message,
        details: {
          deviceId,
          parameterPath
        }
      });
    }
  });
});

export default router;

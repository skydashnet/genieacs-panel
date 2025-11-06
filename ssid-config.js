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
 * POST /api/ssid-config/set-parameter
 * Set a single parameter value for a device in GenieACS
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
      console.error('[SSID Config] Database error:', err);
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

      // Build task payload for GenieACS
      const taskPayload = {
        name: 'setParameterValues',
        parameterValues: [[parameterPath, parameterValue, parameterType]]
      };

      // Create task in GenieACS
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
        console.error(`[SSID Config] GenieACS error (${response.status}):`, errorText);
        throw new Error(`GenieACS returned ${response.status}: ${errorText}`);
      }

      const result = await response.json().catch(() => null);

      // Return success response
      res.json({
        success: true,
        message: 'Parameter set successfully',
        deviceId,
        parameterPath,
        parameterValue,
        taskResponse: result
      });

    } catch (error) {
      console.error('[SSID Config] Error setting parameter:', error.message);
      
      res.status(500).json({
        error: 'Failed to set parameter',
        message: error.message,
        details: {
          deviceId,
          parameterPath,
          parameterValue
        }
      });
    }
  });
});

/**
 * POST /api/ssid-config/set-multiple-parameters
 * Set multiple parameters at once for a device
 * 
 * Body:
 * {
 *   deviceId: string,
 *   parameters: Array<{
 *     path: string,
 *     value: any,
 *     type: string (optional)
 *   }>
 * }
 */
router.post('/set-multiple-parameters', async (req, res) => {
  const { deviceId, parameters } = req.body;

  if (!deviceId || !parameters || !Array.isArray(parameters) || parameters.length === 0) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      message: 'deviceId and parameters array are required'
    });
  }

  // Get GenieACS URL from database
  const db = new sqlite3.Database(dbPath);
  
  db.get('SELECT value FROM settings WHERE key = ?', ['genieAcsUrl'], async (err, row) => {
    if (err) {
      db.close();
      console.error('[SSID Config] Database error:', err);
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

      // Build parameterValues array for GenieACS
      const parameterValues = parameters.map(param => [
        param.path,
        param.value,
        param.type || 'xsd:string'
      ]);

      const taskPayload = {
        name: 'setParameterValues',
        parameterValues
      };

      // Create task in GenieACS
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
        console.error(`[SSID Config] GenieACS error (${response.status}):`, errorText);
        throw new Error(`GenieACS returned ${response.status}: ${errorText}`);
      }

      const result = await response.json().catch(() => null);

      res.json({
        success: true,
        message: 'Parameters set successfully',
        deviceId,
        parametersCount: parameters.length,
        taskResponse: result
      });

    } catch (error) {
      console.error('[SSID Config] Error setting multiple parameters:', error.message);
      
      res.status(500).json({
        error: 'Failed to set parameters',
        message: error.message,
        details: {
          deviceId,
          parametersCount: parameters.length
        }
      });
    }
  });
});

/**
 * POST /api/ssid-config/add-instance
 * Add a new SSID instance (WLANConfiguration object) to the device
 * 
 * Body:
 * {
 *   deviceId: string
 * }
 */
router.post('/add-instance', async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      message: 'deviceId is required'
    });
  }

  // Get GenieACS URL from database
  const db = new sqlite3.Database(dbPath);
  
  db.get('SELECT value FROM settings WHERE key = ?', ['genieAcsUrl'], async (err, row) => {
    if (err) {
      db.close();
      console.error('[SSID Config] Database error:', err);
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

      // Build task payload for GenieACS
      const taskPayload = {
        name: 'addObject',
        objectName: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration'
      };

      // Create task in GenieACS
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
        console.error(`[SSID Config] GenieACS error (${response.status}):`, errorText);
        throw new Error(`GenieACS returned ${response.status}: ${errorText}`);
      }

      const result = await response.json().catch(() => null);

      // Return success response
      res.json({
        success: true,
        message: 'SSID instance added successfully. Please wait for device to sync.',
        deviceId,
        taskResponse: result
      });

    } catch (error) {
      console.error('[SSID Config] Error adding SSID instance:', error.message);
      
      res.status(500).json({
        error: 'Failed to add SSID instance',
        message: error.message,
        details: {
          deviceId
        }
      });
    }
  });
});

export default router;

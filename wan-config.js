/**
 * WAN Configuration Handler
 * 
 * Handles WAN connection parameter configuration operations
 * Separated from SSID configuration for clarity and independent maintenance
 */

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
 * POST /api/wan-config/set-parameter
 * Set a single WAN parameter value for a device in GenieACS
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
      console.error('[WAN Config] Database error:', err);
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
        console.error(`[WAN Config] GenieACS error (${response.status}):`, errorText);
        throw new Error(`GenieACS returned ${response.status}: ${errorText}`);
      }

      const result = await response.json().catch(() => null);

      // Return success response
      res.json({
        success: true,
        message: 'WAN parameter set successfully',
        deviceId,
        parameterPath,
        parameterValue,
        taskResponse: result
      });

    } catch (error) {
      console.error('[WAN Config] Error setting parameter:', error.message);
      
      res.status(500).json({
        error: 'Failed to set WAN parameter',
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
 * POST /api/wan-config/set-multiple-parameters
 * Set multiple WAN parameters at once for a device
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
      console.error('[WAN Config] Database error:', err);
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
        console.error(`[WAN Config] GenieACS error (${response.status}):`, errorText);
        throw new Error(`GenieACS returned ${response.status}: ${errorText}`);
      }

      const result = await response.json().catch(() => null);

      res.json({
        success: true,
        message: 'WAN parameters set successfully',
        deviceId,
        parametersCount: parameters.length,
        taskResponse: result
      });

    } catch (error) {
      console.error('[WAN Config] Error setting multiple parameters:', error.message);
      
      res.status(500).json({
        error: 'Failed to set WAN parameters',
        message: error.message,
        details: {
          deviceId,
          parametersCount: parameters.length
        }
      });
    }
  });
});

export default router;

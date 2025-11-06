import express from 'express';
import axios from 'axios';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'database.sqlite');

/**
 * Get settings from database
 */
async function getSettings() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all('SELECT key, value FROM settings', [], (err, rows) => {
      db.close();
      if (err) {
        reject(err);
      } else {
        const settings = {};
        rows.forEach(row => {
          settings[row.key] = row.value;
        });
        resolve(settings);
      }
    });
  });
}

/**
 * Set security parameter (HTTP WAN Enable or Firewall Level)
 * 
 * POST /api/security-config/set-parameter
 * Body: {
 *   deviceId: string,
 *   parameterPath: string,  // Full path from device data
 *   parameterValue: any     // New value to set
 * }
 */
router.post('/set-parameter', async (req, res) => {
  try {
    const { deviceId, parameterPath, parameterValue } = req.body;

    // Validate input
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: 'Device ID is required'
      });
    }

    if (!parameterPath) {
      return res.status(400).json({
        success: false,
        message: 'Parameter path is required'
      });
    }

    if (parameterValue === undefined || parameterValue === null) {
      return res.status(400).json({
        success: false,
        message: 'Parameter value is required'
      });
    }

    // Get settings
    const settings = await getSettings();
    const genieAcsUrl = settings.genieAcsUrl;

    if (!genieAcsUrl) {
      return res.status(500).json({
        success: false,
        message: 'GenieACS URL not configured in settings'
      });
    }

    // Encode device ID for URL
    const encodedDeviceId = encodeURIComponent(deviceId);
    const taskUrl = `${genieAcsUrl}/${encodedDeviceId}/tasks?timeout=3000&connection_request`;

    // Prepare task payload
    const taskPayload = {
      name: 'setParameterValues',
      parameterValues: [
        [parameterPath, parameterValue]
      ]
    };

    // Send task to GenieACS
    const response = await axios.post(taskUrl, taskPayload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    return res.json({
      success: true,
      message: 'Security parameter update task created successfully',
      taskId: response.data._id || 'unknown',
      parameter: {
        path: parameterPath,
        value: parameterValue
      }
    });

  } catch (error) {
    console.error('❌ Error setting security parameter:', error.message);
    
    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        message: 'GenieACS API error',
        error: error.response.data
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to set security parameter',
      error: error.message
    });
  }
});

export default router;

import express from 'express';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Database setup
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// Helper function to make GenieACS API request
async function makeGenieRequest(url, method = 'GET', data = null) {
  const options = {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  };

  if (data && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, options);
    return {
      http_code: response.status,
      ok: response.ok,
      response: response.ok ? await response.json().catch(() => null) : null
    };
  } catch (error) {
    throw new Error(`Request failed: ${error.message}`);
  }
}

// POST /api/summon-device - Summon device parameters
router.post('/', async (req, res) => {
  const { device_id } = req.body;

  // Validate device_id
  if (!device_id) {
    return res.status(400).json({
      success: false,
      status: 'error',
      alerts: [{ type: 'error', message: 'Device ID is required' }]
    });
  }

  try {
    // Get GenieACS URL and Virtual Parameters from database
    db.all(
      'SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?, ?)',
      ['genieAcsUrl', 'vpPppoeUsername', 'vpWanBridge', 'vpRxPower', 'vpTemperature', 'vpActiveDevices'],
      async (err, settings) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({
            success: false,
            status: 'error',
            alerts: [{ type: 'error', message: 'Database error' }]
          });
        }

        // Convert settings array to object
        const config = {};
        settings.forEach(row => {
          config[row.key] = row.value;
        });

        // Check if GenieACS URL is configured
        if (!config.genieAcsUrl) {
          return res.status(500).json({
            success: false,
            status: 'error',
            alerts: [{ type: 'error', message: 'GenieACS URL not configured' }]
          });
        }

        const baseUrl = config.genieAcsUrl;

        // Get virtual parameter names from database or use defaults
        const vpPppoeUsername = config.vpPppoeUsername || 'VirtualParameters.pppoeUsername';
        const vpWanBridge = config.vpWanBridge || 'VirtualParameters.WANBRIDGE';
        const vpRxPower = config.vpRxPower || 'VirtualParameters.RXPower';
        const vpTemperature = config.vpTemperature || 'VirtualParameters.gettemp';
        const vpActiveDevices = config.vpActiveDevices || 'VirtualParameters.activedevices';

        // Parameters to summon - matching getdevice.js projection
        const parametersToSummon = [
          'DeviceID.SerialNumber',
          vpPppoeUsername,
          vpWanBridge,
          vpRxPower,
          vpTemperature,
          vpActiveDevices,
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.SSID'
        ];

        // GenieACS device-specific tasks endpoint
        const deviceTasksUrl = `${baseUrl}/${encodeURIComponent(device_id)}/tasks?connection_request`;

        let summonCount = 0;
        let failedCount = 0;
        const alerts = [];

        try {
          // Separate VirtualParameters and regular parameters
          const virtualParams = [];
          const regularParams = [];

          parametersToSummon.forEach(param => {
            if (param.startsWith('VirtualParameters.')) {
              virtualParams.push(param);
            } else {
              regularParams.push(param);
            }
          });

          // Batch summon VirtualParameters if any
          if (virtualParams.length > 0) {
            try {
              const taskData = {
                name: 'getParameterValues',
                parameterNames: virtualParams
              };

              const taskResponse = await makeGenieRequest(deviceTasksUrl, 'POST', taskData);

              if (taskResponse.ok || [200, 201, 202].includes(taskResponse.http_code)) {
                summonCount += virtualParams.length;
              } else {
                failedCount += virtualParams.length;
                console.error(`Failed to summon VirtualParameters, HTTP Code: ${taskResponse.http_code}`);
              }
            } catch (error) {
              failedCount += virtualParams.length;
              console.error('Exception while summoning VirtualParameters:', error.message);
            }

            // Small delay before next batch
            await new Promise(resolve => setTimeout(resolve, 100));
          }

          // Batch summon regular parameters if any
          if (regularParams.length > 0) {
            try {
              const taskData = {
                name: 'getParameterValues',
                parameterNames: regularParams
              };

              const taskResponse = await makeGenieRequest(deviceTasksUrl, 'POST', taskData);

              if (taskResponse.ok || [200, 201, 202].includes(taskResponse.http_code)) {
                summonCount += regularParams.length;
              } else {
                failedCount += regularParams.length;
                console.error(`Failed to summon regular parameters, HTTP Code: ${taskResponse.http_code}`);
              }
            } catch (error) {
              failedCount += regularParams.length;
              console.error('Exception while summoning regular parameters:', error.message);
            }
          }

          // Prepare response based on results
          let success = false;
          
          if (summonCount > 0) {
            success = true;
            if (failedCount === 0) {
              alerts.push({
                type: 'success',
                message: `Successfully summoned all ${summonCount} parameters`
              });
            } else {
              alerts.push({
                type: 'warning',
                message: `Summoned ${summonCount} parameters, ${failedCount} failed`
              });
            }
          } else {
            alerts.push({
              type: 'error',
              message: 'Failed to summon any parameters'
            });
          }

          // Return response
          res.json({
            success: success,
            status: success ? 'success' : 'error',
            alerts: alerts,
            device_id: device_id,
            summoned: summonCount,
            failed: failedCount,
            timestamp: new Date().toISOString()
          });

        } catch (error) {
          console.error('Error summoning device:', error);
          res.status(500).json({
            success: false,
            status: 'error',
            alerts: [{ type: 'error', message: `Error summoning device: ${error.message}` }],
            device_id: device_id,
            timestamp: new Date().toISOString()
          });
        }
      }
    );
  } catch (error) {
    console.error('Error in summon-device endpoint:', error);
    res.status(500).json({
      success: false,
      status: 'error',
      alerts: [{ type: 'error', message: 'Internal server error' }],
      timestamp: new Date().toISOString()
    });
  }
});

export default router;

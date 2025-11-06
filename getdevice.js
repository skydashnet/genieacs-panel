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

// GET /api/getdevice - Fetch devices from GenieACS
router.get('/', async (req, res) => {
  try {
    // Get GenieACS URL and Virtual Parameters from database
    db.all('SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?, ?)', 
      ['genieAcsUrl', 'vpPppoeUsername', 'vpWanBridge', 'vpRxPower', 'vpTemperature', 'vpActiveDevices'], 
      async (err, settings) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ 
          error: 'Database error',
          detail: err.message
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
          error: 'GenieACS URL not configured',
          detail: 'Please configure GenieACS URL in settings first'
        });
      }

      const baseUrl = config.genieAcsUrl;

      // Get virtual parameter names from database or use defaults
      const vpPppoeUsername = config.vpPppoeUsername || 'VirtualParameters.pppoeUsername';
      const vpWanBridge = config.vpWanBridge || 'VirtualParameters.WANBRIDGE';
      const vpRxPower = config.vpRxPower || 'VirtualParameters.RXPower';
      const vpTemperature = config.vpTemperature || 'VirtualParameters.gettemp';
      const vpActiveDevices = config.vpActiveDevices || 'VirtualParameters.activedevices';

      // Projection fields - only fetch what we need (using dynamic VP names)
      const projection = [
        '_id',
        '_deviceId._ProductClass',
        '_deviceId._SerialNumber',
        vpPppoeUsername,
        vpWanBridge,
        vpRxPower,
        vpTemperature,
        vpActiveDevices,
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.SSID',
          '_lastInform'
      ];

      // Build API URL with projection (baseUrl already includes /devices)
      const apiUrl = `${baseUrl}?projection=${encodeURIComponent(projection.join(','))}`;
      

      try {
        // Fetch data from GenieACS API
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip'
          }
        });

        if (!response.ok) {
          return res.status(response.status).json({
            error: 'Failed to fetch from GenieACS',
            detail: `Status: ${response.status} ${response.statusText}`
          });
        }

        const data = await response.json();

        if (!Array.isArray(data)) {
          return res.status(500).json({
            error: 'Invalid API response',
            detail: 'Expected array from GenieACS API'
          });
        }

        // Helper function to get value from nested path
        const getNestedValue = (obj, path) => {
          const parts = path.split('.');
          let current = obj;
          
          for (const part of parts) {
            if (current && typeof current === 'object') {
              current = current[part];
            } else {
              return null;
            }
          }
          
          // If final value has _value property, return that
          return current?._value || null;
        };

        // Process and format data
        const output = data.map(item => {
          // Get virtual parameter values using dynamic paths
          const pppsecret = getNestedValue(item, vpPppoeUsername);
          const wanbridge = getNestedValue(item, vpWanBridge);
          const rxpower = getNestedValue(item, vpRxPower);
          const gettemp = getNestedValue(item, vpTemperature);
          const activedevices = getNestedValue(item, vpActiveDevices);

          // Get device identifiers
          const deviceId = item._id || null;
          const serialNumber = item._deviceId?._SerialNumber || null;
          const typeont = item._deviceId?._ProductClass || null;

          // Get SSID from WLANConfiguration 1-4
          const wlan = item.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
          const ssid1 = wlan['1']?.SSID?._value || null;
          const ssid2 = wlan['2']?.SSID?._value || null;
          const ssid3 = wlan['3']?.SSID?._value || null;
          const ssid4 = wlan['4']?.SSID?._value || null;
          const ssid5 = wlan['5']?.SSID?._value || null;
          const ssid6 = wlan['6']?.SSID?._value || null;
          const ssid7 = wlan['7']?.SSID?._value || null;
          const ssid8 = wlan['8']?.SSID?._value || null;

          // Format _lastInform to WIB (Asia/Jakarta, UTC+7)
          let lastInformWIB = null;
          if (item._lastInform) {
            try {
              const date = new Date(item._lastInform);
              // Convert to WIB (UTC+7)
              const wibOffset = 7 * 60; // 7 hours in minutes
              const wibDate = new Date(date.getTime() + wibOffset * 60 * 1000);
              
              // Format as YYYY-MM-DD HH:mm:ss
              const year = wibDate.getUTCFullYear();
              const month = String(wibDate.getUTCMonth() + 1).padStart(2, '0');
              const day = String(wibDate.getUTCDate()).padStart(2, '0');
              const hours = String(wibDate.getUTCHours()).padStart(2, '0');
              const minutes = String(wibDate.getUTCMinutes()).padStart(2, '0');
              const seconds = String(wibDate.getUTCSeconds()).padStart(2, '0');
              
              lastInformWIB = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            } catch (e) {
              lastInformWIB = 'Invalid date';
            }
          }

          return {
            _id: deviceId,
            SerialNumber: serialNumber,
            productclass: typeont,
            pppoe: pppsecret,
            wanbridge: wanbridge,
            rxpower: rxpower,
            temperature: gettemp,
            activedevices: activedevices,
            ssid1: ssid1,
            ssid2: ssid2,
            ssid3: ssid3,
            ssid4: ssid4,
            ssid5: ssid5,
            ssid6: ssid6,
            ssid7: ssid7,
            ssid8: ssid8,
            _lastInform: lastInformWIB
          };
        });

        // Return reversed array (newest first)
        res.json(output.reverse());

      } catch (fetchError) {
        console.error('Error fetching devices:', fetchError);
        res.status(500).json({
          error: 'Failed to fetch from GenieACS',
          detail: fetchError.message
        });
      }
    });

  } catch (error) {
    console.error('Error in getdevice endpoint:', error);
    res.status(500).json({
      error: 'Internal server error',
      detail: error.message
    });
  }
});

export default router;

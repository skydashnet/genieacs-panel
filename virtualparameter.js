import express from 'express';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path
const dbPath = path.join(__dirname, 'database.sqlite');

// GET /api/virtualparameters - Get all virtual parameters
router.get('/', (req, res) => {
  const db = new sqlite3.Database(dbPath);
  
  db.all('SELECT key, value FROM settings WHERE key LIKE ?', ['vp%'], (err, rows) => {
    if (err) {
      console.error('Error fetching virtual parameters:', err);
      db.close();
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch virtual parameters',
        error: err.message
      });
    }
    
    // Convert to object format
    const virtualParameters = {};
    rows.forEach(row => {
      virtualParameters[row.key] = row.value;
    });
    
    // If no virtual parameters found, return defaults
    if (Object.keys(virtualParameters).length === 0) {
      virtualParameters.vpPppoeUsername = 'VirtualParameters.pppoeUsername';
      virtualParameters.vpWanBridge = 'VirtualParameters.WANBRIDGE';
      virtualParameters.vpRxPower = 'VirtualParameters.RXPower';
      virtualParameters.vpTemperature = 'VirtualParameters.gettemp';
      virtualParameters.vpActiveDevices = 'VirtualParameters.activedevices';
      virtualParameters.vpSuperAdmin = 'VirtualParameters.superAdmin';
      virtualParameters.vpSuperPassword = 'VirtualParameters.superPassword';
      virtualParameters.vpUserAdmin = 'VirtualParameters.userAdmin';
      virtualParameters.vpUserPassword = 'VirtualParameters.userPassword';
    }
    
    db.close();
    
    res.json({
      success: true,
      data: virtualParameters
    });
  });
});

// POST /api/virtualparameters - Save all virtual parameters
router.post('/', (req, res) => {
  const { 
    vpPppoeUsername, 
    vpWanBridge, 
    vpRxPower, 
    vpTemperature, 
    vpActiveDevices,
    vpSuperAdmin,
    vpSuperPassword,
    vpUserAdmin,
    vpUserPassword
  } = req.body;
  
  // Validate required fields (ALL fields are required)
  if (!vpPppoeUsername || !vpWanBridge || !vpRxPower || !vpTemperature || !vpActiveDevices || 
      !vpSuperAdmin || !vpSuperPassword || !vpUserAdmin || !vpUserPassword) {
    return res.status(400).json({
      success: false,
      message: 'All virtual parameters are required'
    });
  }
  
  const db = new sqlite3.Database(dbPath);
  
  // Helper function to save a parameter
  const saveParameter = (key, value) => {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?) 
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  };
  
  // Save all parameters (all are required)
  const parametersToSave = [
    saveParameter('vpPppoeUsername', vpPppoeUsername),
    saveParameter('vpWanBridge', vpWanBridge),
    saveParameter('vpRxPower', vpRxPower),
    saveParameter('vpTemperature', vpTemperature),
    saveParameter('vpActiveDevices', vpActiveDevices),
    saveParameter('vpSuperAdmin', vpSuperAdmin),
    saveParameter('vpSuperPassword', vpSuperPassword),
    saveParameter('vpUserAdmin', vpUserAdmin),
    saveParameter('vpUserPassword', vpUserPassword)
  ];

  Promise.all(parametersToSave)
    .then(() => {
      db.close();
      res.json({
        success: true,
        message: 'Virtual parameters saved successfully',
        data: {
          vpPppoeUsername,
          vpWanBridge,
          vpRxPower,
          vpTemperature,
          vpActiveDevices,
          vpSuperAdmin,
          vpSuperPassword,
          vpUserAdmin,
          vpUserPassword
        }
      });
    })
    .catch((error) => {
      console.error('Error saving virtual parameters:', error);
      db.close();
      res.status(500).json({
        success: false,
        message: 'Failed to save virtual parameters',
        error: error.message
      });
    });
});

// PUT /api/virtualparameters/:key - Update single virtual parameter
router.put('/:key', (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  
  // Validate key
  const validKeys = ['vpPppoeUsername', 'vpWanBridge', 'vpRxPower', 'vpTemperature', 'vpActiveDevices'];
  if (!validKeys.includes(key)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid virtual parameter key'
    });
  }
  
  // Validate value
  if (!value || typeof value !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Value is required and must be a string'
    });
  }
  
  const db = new sqlite3.Database(dbPath);
  
  db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?) 
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
    (err) => {
      db.close();
      
      if (err) {
        console.error('Error updating virtual parameter:', err);
        return res.status(500).json({
          success: false,
          message: 'Failed to update virtual parameter',
          error: err.message
        });
      }
      
      res.json({
        success: true,
        message: `Virtual parameter ${key} updated successfully`,
        data: {
          key,
          value
        }
      });
    }
  );
});

export default router;

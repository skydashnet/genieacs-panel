import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import getdeviceRouter from './getdevice.js';
import virtualparameterRouter from './virtualparameter.js';
import summonDeviceRouter from './summon-device.js';
import summonDetailDeviceRouter from './summon-detaildevice.js';
import { getDetailDevice } from './getdetaildevice.js';
import vendorManagementRouter from './vendor-management.js';
import dashboardRouter from './dashboard.js';
import deleteDeviceRouter from './delete-device.js';
import wifiSecurityConfigRouter from './wifi-security-config.js';
import ssidConfigRouter from './ssid-config.js';
import wanConfigRouter from './wan-config.js';
import credentialConfigRouter from './credential-config.js';
import rebootDeviceRouter from './reboot-device.js';
import securityConfigRouter from './security-config.js';
import mapSettingsRouter from './map-settings.js';
import mappingDataRouter from './mapping-data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const app = express();
// Use environment variable PORT or default to 1945 for production
const PORT = process.env.PORT || 1997;

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-for-development-only';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files in production (when public folder exists)
const publicPath = path.join(__dirname, 'public');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(publicPath));
}

// Database setup
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Could not connect to database', err);
  } else {
    initializeDatabase();
  }
});

// Initialize database with tables
function initializeDatabase() {
  // Create users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, function(err) {
    if (err) {
      console.error('Error creating users table', err);
    } else {
      
      // Check if admin user exists
      db.get('SELECT * FROM users WHERE username = ?', ['admin'], (err, row) => {
        if (err) {
          console.error('Error checking admin user', err);
        } else if (!row) {
          // Create default admin user if not exists
          bcrypt.hash('admin123', 12, (err, hash) => {
            if (err) {
              console.error('Error hashing password', err);
            } else {
              db.run(
                'INSERT INTO users (username, password, role) VALUES (?, ?, ?)', 
                ['admin', hash, 'admin'],
                function(err) {
                  if (err) {
                    console.error('Error creating admin user', err);
                  } else {
                  }
                }
              );
            }
          });
        }
      });
    }
  });
  
  // Create settings table
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, function(err) {
    if (err) {
      console.error('Error creating settings table', err);
    } else {
      
      // Check if app name setting exists
      db.get('SELECT * FROM settings WHERE key = ?', ['appName'], (err, row) => {
        if (err) {
          console.error('Error checking app name setting', err);
        } else if (!row) {
          // Create default app name if not exists
          db.run(
            'INSERT INTO settings (key, value) VALUES (?, ?)', 
            ['appName', 'GenieACS Panel'],
            function(err) {
              if (err) {
                console.error('Error creating app name setting', err);
              } else {
              }
            }
          );
        }
      });
      
      // Check if genieAcsUrl setting exists
      db.get('SELECT * FROM settings WHERE key = ?', ['genieAcsUrl'], (err, row) => {
        if (err) {
          console.error('Error checking genieAcsUrl setting', err);
        } else if (!row) {
          // Create default genieAcsUrl if not exists
          db.run(
            'INSERT INTO settings (key, value) VALUES (?, ?)', 
            ['genieAcsUrl', 'http://localhost:7557/devices'],
            function(err) {
              if (err) {
                console.error('Error creating genieAcsUrl setting', err);
              } else {
              }
            }
          );
        }
      });
    }
  });
}

// Generate JWT tokens
function generateTokens(user) {
  // Create access token (short-lived)
  const accessToken = jwt.sign(
    { 
      userId: user.id, 
      username: user.username,
      role: user.role 
    }, 
    JWT_SECRET, 
    { expiresIn: JWT_EXPIRES_IN }
  );
  
  // Create refresh token (long-lived)
  const refreshToken = jwt.sign(
    { 
      userId: user.id,
      tokenType: 'refresh'
    },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );
  
  return { accessToken, refreshToken };
}

// Verify JWT token
function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    console.error('Token verification error:', error.message);
    return null;
  }
}

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Authentication token required' });
  }
  
  // Verify JWT token
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      // Handle different JWT errors
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          message: 'Token expired', 
          code: 'token_expired'
        });
      }
      
      return res.status(403).json({ 
        message: 'Invalid token', 
        code: 'invalid_token'
      });
    }
    
    // Add user data to request
    req.user = user;
    next();
  });
}

// Routes
// Register getdevice router
app.use('/api/getdevice', authenticateToken, getdeviceRouter);

// Register virtualparameter router
app.use('/api/virtualparameters', authenticateToken, virtualparameterRouter);

// Register summon-device router
app.use('/api/summon-device', authenticateToken, summonDeviceRouter);

// Register summon-detaildevice router
app.use('/api/summon-detaildevice', authenticateToken, summonDetailDeviceRouter);

// Register vendor-management router
app.use('/api/vendor-management', authenticateToken, vendorManagementRouter);

// Register dashboard router
app.use('/api/dashboard', authenticateToken, dashboardRouter);

// Register delete-device router
app.use('/api/delete-device', authenticateToken, deleteDeviceRouter);

// Register wifi-security-config router
app.use('/api/wifi-security-config', authenticateToken, wifiSecurityConfigRouter);

// Register ssid-config router
app.use('/api/ssid-config', authenticateToken, ssidConfigRouter);

// Register wan-config router
app.use('/api/wan-config', authenticateToken, wanConfigRouter);

// Register credential-config router
app.use('/api/credential-config', authenticateToken, credentialConfigRouter);

// Register reboot-device router
app.use('/api/reboot-device', authenticateToken, rebootDeviceRouter);

// Register security-config router
app.use('/api/security-config', authenticateToken, securityConfigRouter);

// Register map-settings router
app.use('/api/map-settings', authenticateToken, mapSettingsRouter);

// Register mapping-data router
app.use('/api/mapping-data', authenticateToken, mappingDataRouter);

// Get detail device route
app.get('/api/getdetaildevice/:deviceId', authenticateToken, async (req, res) => {
  try {
    // Express auto-decodes URL params
    // Use decoded device ID directly (same approach as summon-device)
    const { deviceId } = req.params;
    
    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID parameter is required' });
    }

    const deviceDetail = await getDetailDevice(deviceId);
    res.json(deviceDetail);
  } catch (error) {
    console.error('Error fetching device detail:', error);
    
    if (error.message === 'Device not found') {
      return res.status(404).json({ 
        error: 'Device not found', 
        deviceId: req.params.deviceId,
        message: 'Device ID not found in GenieACS. Please verify the device ID is correct.'
      });
    }
    
    res.status(500).json({ error: 'Failed to fetch device details', detail: error.message });
  }
});

// Login route
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }
  
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) {
      console.error('Database error during login', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
    
    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
    bcrypt.compare(password, user.password, (err, isMatch) => {
      if (err) {
        console.error('Password comparison error', err);
        return res.status(500).json({ message: 'Internal server error' });
      }
      
      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid username or password' });
      }
      
      // Generate JWT tokens
      const { accessToken, refreshToken } = generateTokens(user);
      
      // Store refresh token in database (optional, implemented in future)
      
      res.json({
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          createdAt: user.created_at,
          updatedAt: user.updated_at
        },
        token: accessToken,
        refreshToken
      });
    });
  });
});

// Get current user
app.get('/api/auth/user', authenticateToken, (req, res) => {
  db.get('SELECT id, username, role, created_at, updated_at FROM users WHERE id = ?', [req.user.userId], (err, user) => {
    if (err) {
      console.error('Error getting user', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.created_at,
      updatedAt: user.updated_at
    });
  });
});

// Logout endpoint
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logout successful' });
});

// Refresh token endpoint
app.post('/api/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return res.status(400).json({ message: 'Refresh token is required' });
  }
  
  try {
    // Verify the refresh token
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    
    // Check if token is a refresh token
    if (!decoded.tokenType || decoded.tokenType !== 'refresh') {
      return res.status(403).json({ message: 'Invalid token type' });
    }
    
    // Get user from database
    db.get('SELECT * FROM users WHERE id = ?', [decoded.userId], (err, user) => {
      if (err) {
        console.error('Database error during token refresh', err);
        return res.status(500).json({ message: 'Internal server error' });
      }
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Generate new tokens
      const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);
      
      // Return new tokens
      return res.json({
        token: accessToken,
        refreshToken: newRefreshToken
      });
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(403).json({ message: 'Refresh token expired' });
    }
    
    return res.status(403).json({ message: 'Invalid refresh token' });
  }
});

// Change password
// Change username endpoint
app.post('/api/auth/change-username', authenticateToken, (req, res) => {
  const { currentUsername, newUsername } = req.body;
  
  if (!currentUsername || !newUsername) {
    return res.status(400).json({ message: 'Current username and new username are required' });
  }
  
  db.get('SELECT * FROM users WHERE id = ?', [req.user.userId], (err, user) => {
    if (err) {
      console.error('Database error during username change', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if current username matches
    if (user.username !== currentUsername) {
      return res.status(401).json({ message: 'Current username is incorrect' });
    }
    
    // Check if new username already exists
    db.get('SELECT * FROM users WHERE username = ? AND id != ?', [newUsername, req.user.userId], (err, existingUser) => {
      if (err) {
        console.error('Database error checking existing username', err);
        return res.status(500).json({ message: 'Internal server error' });
      }
      
      if (existingUser) {
        return res.status(409).json({ message: 'Username already taken' });
      }
      
      db.run(
        'UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
        [newUsername, req.user.userId],
        function(err) {
          if (err) {
            console.error('Error updating username', err);
            return res.status(500).json({ message: 'Internal server error' });
          }
          
          res.json({ message: 'Username updated successfully' });
        }
      );
    });
  });
});

app.post('/api/auth/change-password', authenticateToken, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Current password and new password are required' });
  }
  
  db.get('SELECT * FROM users WHERE id = ?', [req.user.userId], (err, user) => {
    if (err) {
      console.error('Database error during password change', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    bcrypt.compare(currentPassword, user.password, (err, isMatch) => {
      if (err) {
        console.error('Password comparison error', err);
        return res.status(500).json({ message: 'Internal server error' });
      }
      
      if (!isMatch) {
        return res.status(401).json({ message: 'Current password is incorrect' });
      }
      
      bcrypt.hash(newPassword, 12, (err, hash) => {
        if (err) {
          console.error('Error hashing password', err);
          return res.status(500).json({ message: 'Internal server error' });
        }
        
        db.run(
          'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
          [hash, req.user.userId],
          function(err) {
            if (err) {
              console.error('Error updating password', err);
              return res.status(500).json({ message: 'Internal server error' });
            }
            
            res.json({ message: 'Password updated successfully' });
          }
        );
      });
    });
  });
});

// Settings endpoints
app.get('/api/settings', authenticateToken, (req, res) => {
  db.all('SELECT key, value FROM settings', [], (err, settings) => {
    if (err) {
      console.error('Error getting settings', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
    
    // Convert to object format
    const settingsObj = settings.reduce((acc, setting) => {
      acc[setting.key] = setting.value;
      return acc;
    }, {});
    
    res.json(settingsObj);
  });
});

// Test GenieACS connection (must be before /:key route)
app.post('/api/settings/test-genieacs', authenticateToken, async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ message: 'URL is required' });
  }
  
  try {
    // Add ?limit=1 to the URL
    let testUrl = url.trim();
    
    // Remove trailing slash if exists
    if (testUrl.endsWith('/')) {
      testUrl = testUrl.slice(0, -1);
    }
    
    // Add ?limit=1 parameter
    testUrl = `${testUrl}?limit=1`;
    
    
    // Use dynamic import for node-fetch
    const fetch = (await import('node-fetch')).default;
    
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      // Set timeout
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      return res.status(502).json({ 
        success: false,
        message: `GenieACS server returned status ${response.status}`,
        statusCode: response.status
      });
    }
    
    // Try to parse response as JSON
    const data = await response.json();
    
    // Check if response is an array (expected format from GenieACS)
    if (Array.isArray(data)) {
      return res.json({ 
        success: true,
        message: 'Connection successful!',
        deviceCount: data.length
      });
    } else {
      return res.json({ 
        success: true,
        message: 'Connection successful, but unexpected response format'
      });
    }
  } catch (error) {
    console.error('GenieACS connection test failed:', error);
    
    if (error.name === 'AbortError' || error.type === 'request-timeout') {
      return res.status(504).json({ 
        success: false,
        message: 'Connection timeout - GenieACS server did not respond'
      });
    }
    
    if (error.code === 'ECONNREFUSED') {
      return res.status(502).json({ 
        success: false,
        message: 'Connection refused - GenieACS server is not running or URL is incorrect'
      });
    }
    
    return res.status(502).json({ 
      success: false,
      message: error.message || 'Failed to connect to GenieACS server'
    });
  }
});

app.get('/api/settings/:key', authenticateToken, (req, res) => {
  const { key } = req.params;
  
  db.get('SELECT value FROM settings WHERE key = ?', [key], (err, setting) => {
    if (err) {
      console.error(`Error getting setting ${key}`, err);
      return res.status(500).json({ message: 'Internal server error' });
    }
    
    if (!setting) {
      return res.status(404).json({ message: 'Setting not found' });
    }
    
    res.json({ [key]: setting.value });
  });
});

app.put('/api/settings/:key', authenticateToken, (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  
  if (!value) {
    return res.status(400).json({ message: 'Value is required' });
  }
  
  db.get('SELECT * FROM settings WHERE key = ?', [key], (err, setting) => {
    if (err) {
      console.error(`Error checking setting ${key}`, err);
      return res.status(500).json({ message: 'Internal server error' });
    }
    
    if (!setting) {
      // Insert new setting
      db.run(
        'INSERT INTO settings (key, value) VALUES (?, ?)', 
        [key, value],
        function(err) {
          if (err) {
            console.error(`Error creating setting ${key}`, err);
            return res.status(500).json({ message: 'Internal server error' });
          }
          
          res.json({ [key]: value });
        }
      );
    } else {
      // Update existing setting
      db.run(
        'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?', 
        [value, key],
        function(err) {
          if (err) {
            console.error(`Error updating setting ${key}`, err);
            return res.status(500).json({ message: 'Internal server error' });
          }
          
          res.json({ [key]: value });
        }
      );
    }
  });
});

// Serve frontend in production - catch all routes for SPA
if (process.env.NODE_ENV === 'production') {
  app.use((req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });
}


// Start server
app.listen(PORT, () => {
  console.log(`======================================`);
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  if (process.env.NODE_ENV === 'production') {
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`API: http://localhost:${PORT}/api`);
  }
  console.log(`======================================`);
});
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

// DELETE /api/delete-device/:deviceId - Delete device from GenieACS
router.delete('/:deviceId', async (req, res) => {
  try {
    // Get device ID from URL params
    const { deviceId } = req.params;
    
    if (!deviceId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Device ID parameter is required' 
      });
    }
    
    
    // Get GenieACS URL from database settings
    db.get('SELECT value FROM settings WHERE key = ?', ['genieAcsUrl'], async (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ 
          success: false, 
          message: 'Database error', 
          error: err.message 
        });
      }
      
      if (!row || !row.value) {
        console.error('GenieACS URL setting not found');
        return res.status(500).json({ 
          success: false, 
          message: 'GenieACS URL not configured' 
        });
      }
      
      // Format GenieACS URL
      const baseUrl = row.value.endsWith('/') ? row.value.slice(0, -1) : row.value;
      const url = `${baseUrl}/${encodeURIComponent(deviceId)}`;
      
      
      try {
        // Make the DELETE request to GenieACS
        const response = await fetch(url, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
          },
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`GenieACS delete API error: ${response.status}`, errorText);
          return res.status(response.status).json({
            success: false,
            message: `Failed to delete device (${response.status})`,
            details: errorText
          });
        }
        
        
        // Return success response
        return res.json({
          success: true,
          message: 'Device deleted successfully',
          deviceId: deviceId,
          timestamp: new Date().toISOString()
        });
        
      } catch (fetchError) {
        console.error('Error making GenieACS delete request:', fetchError);
        return res.status(500).json({
          success: false,
          message: 'Error connecting to GenieACS',
          error: fetchError.message
        });
      }
    });
    
  } catch (error) {
    console.error('Error in delete device endpoint:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

export default router;
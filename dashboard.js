import express from 'express';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { getRxPowerDistribution } from './dashboard-rxpower.js';



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Database setup
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// Helper function to get GenieACS URL from database
const getGenieAcsUrl = () => {
  return new Promise((resolve, reject) => {
    db.get('SELECT value FROM settings WHERE key = ?', ['genieAcsUrl'], (err, row) => {
      if (err) {
        return reject(err);
      }
      if (!row) {
        return reject(new Error('GenieACS URL not configured'));
      }
      resolve(row.value);
    });
  });
};

// Helper function to fetch data from GenieACS
const fetchFromGenieAcs = async (endpoint, query = {}) => {
  try {
    const baseUrl = await getGenieAcsUrl();
    
    // Build URL with query parameters
    let url = new URL(baseUrl);
    // Remove "/devices" from the end if present
    url = new URL(url.origin + (url.pathname.replace(/\/devices\/?$/, '')));
    
    // Add endpoint
    url = new URL(endpoint, url);
    
    // Add query parameters
    Object.keys(query).forEach(key => {
      if (query[key] !== undefined && query[key] !== null) {
        url.searchParams.append(key, query[key]);
      }
    });
    
    // Add timeout for requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`GenieACS API responded with status: ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  } catch (error) {
    console.error('Error fetching from GenieACS:', error);
    throw error;
  }
};

// Helper function to get value from nested path (same as in getdevice.js)
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

// 1. Dashboard Overview - Get device metrics
router.get('/metrics', async (req, res) => {
  try {
    const baseUrl = await getGenieAcsUrl();
    
    // Calculate total devices count
    const totalDevicesQuery = {};
    const totalDevicesResponse = await fetchFromGenieAcs('/devices', {
      query: JSON.stringify(totalDevicesQuery),
      projection: '_id'
    });
    const totalDevices = totalDevicesResponse.length;
    
    // Calculate online devices (devices with recent _lastInform)
    // Using 10-minute threshold like in Devices/index.tsx
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const onlineDevicesQuery = {
      _lastInform: { $gt: tenMinutesAgo.toISOString() }
    };
    const onlineDevicesResponse = await fetchFromGenieAcs('/devices', {
      query: JSON.stringify(onlineDevicesQuery),
      projection: '_id'
    });
    const onlineDevices = onlineDevicesResponse.length;
    
    // Calculate offline devices
    const offlineDevices = totalDevices - onlineDevices;
    
    // Get faults count
    const faultsResponse = await fetchFromGenieAcs('/faults', {});
    const faults = faultsResponse.length;
    
    // Calculate percentage changes (mock data for now)
    // In a real implementation, you would compare with last week's data
    const totalChange = Math.round((Math.random() * 20) - 10); // -10 to +10
    const onlineChange = Math.round((Math.random() * 16) - 8);  // -8 to +8
    const offlineChange = Math.round((Math.random() * 14) - 7); // -7 to +7
    const faultsChange = Math.round((Math.random() * 10) - 5);  // -5 to +5
    
    res.json({
      metrics: [
        { name: "Total Devices", value: totalDevices, status: totalChange >= 0 ? "up" : "down", change: totalChange },
        { name: "Online", value: onlineDevices, status: onlineChange >= 0 ? "up" : "down", change: onlineChange },
        { name: "Offline", value: offlineDevices, status: offlineChange <= 0 ? "up" : "down", change: offlineChange },
        { name: "Faults", value: faults, status: faultsChange <= 0 ? "up" : "warning", change: faultsChange }
      ]
    });
  } catch (error) {
    console.error('Error getting device metrics:', error);
    res.status(500).json({
      error: 'Failed to get device metrics',
      details: error.message
    });
  }
});

// 2. Connection History - Last 7 days
router.get('/connection-history', async (req, res) => {
  try {
    // In a production environment, this would fetch real data from logs
    // For now, we'll generate simulated data for the past week
    
    const days = [];
    const connectionsData = [];
    const disconnectionsData = [];
    
    // Generate data for the last 7 days
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      // Format date as day name (e.g., "Mon", "Tue")
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
      days.push(dayName);
      
      // Generate random connection counts
      connectionsData.push(Math.floor(Math.random() * 150) + 50);
      disconnectionsData.push(Math.floor(Math.random() * 50) + 20);
    }
    
    res.json({
      labels: days,
      series: [
        {
          name: "Connections",
          data: connectionsData
        },
        {
          name: "Disconnections",
          data: disconnectionsData
        }
      ]
    });
  } catch (error) {
    console.error('Error getting connection history:', error);
    res.status(500).json({
      error: 'Failed to get connection history',
      details: error.message
    });
  }
});

// 3. Get Connection Types
router.get('/connection-types', async (req, res) => {
  try {
    // This would typically analyze devices based on their type/model
    // For now, we'll get actual device counts by product class
    
    const baseUrl = await getGenieAcsUrl();
    const allDevices = await fetchFromGenieAcs('/devices', {
      projection: '_deviceId._ProductClass'
    });
    
    // Count devices by product class
    const productClasses = {};
    allDevices.forEach(device => {
      const productClass = device?._deviceId?._ProductClass || 'Unknown';
      if (!productClasses[productClass]) {
        productClasses[productClass] = 0;
      }
      productClasses[productClass]++;
    });
    
    // Convert to array format - show all product classes
    const connectionTypes = Object.entries(productClasses)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value); // Sort by count (descending)
      // No slicing - show all product classes
    
    
    // Generate data for chart
    const labels = connectionTypes.map(type => type.name);
    const values = connectionTypes.map(type => type.value);
    
    // Generate more colors for all product classes
    const baseColors = [
      '#4B72B0', // Blue
      '#BF6F50', // Orange/Brown
      '#55A868', // Green
      '#C44E52', // Red
      '#8172B0', // Purple
      '#BA68C8', // Pink
      '#4FC3F7', // Light Blue
      '#FFB74D', // Orange
      '#81C784'  // Light Green
    ];
    
    // Make sure we have enough colors
    const colors = [];
    for (let i = 0; i < connectionTypes.length; i++) {
      colors.push(baseColors[i % baseColors.length]);
    }
    
    // Calculate total devices
    const totalDevices = connectionTypes.reduce((sum, type) => sum + type.value, 0);
    
    res.json({
      connectionTypes,
      chartData: {
        labels,
        series: [{
          name: "Devices",
          data: values
        }],
        colors,
        totalDevices
      }
    });
  } catch (error) {
    console.error('Error getting connection types:', error);
    res.status(500).json({
      error: 'Failed to get connection types',
      details: error.message
    });
  }
});

// 4. Get Recent Events (Tasks and Faults)
router.get('/events', async (req, res) => {
  try {
    // Get recent tasks
    const tasksResponse = await fetchFromGenieAcs('/tasks', {});
    
    // Count tasks by name
    const taskCounts = {};
    tasksResponse.forEach(task => {
      const name = task.name || 'Unknown';
      if (!taskCounts[name]) {
        taskCounts[name] = 0;
      }
      taskCounts[name]++;
    });
    
    // Convert to array format
    const events = Object.entries(taskCounts)
      .map(([event, count], id) => ({ id: id + 1, event, count }))
      .sort((a, b) => b.count - a.count) // Sort by count (descending)
      .slice(0, 5); // Take top 5
    
    // If we have fewer than 5 events, pad with sample data
    if (events.length < 5) {
      const defaultEvents = [
        { id: 1, event: "Device Boot", count: 0 },
        { id: 2, event: "Periodic Inform", count: 0 },
        { id: 3, event: "Value Change", count: 0 },
        { id: 4, event: "Connection Request", count: 0 },
        { id: 5, event: "Diagnostics Complete", count: 0 }
      ];
      
      // Add missing events
      for (let i = events.length; i < 5; i++) {
        events.push(defaultEvents[i]);
      }
    }
    
    res.json({ events });
  } catch (error) {
    console.error('Error getting events:', error);
    res.status(500).json({
      error: 'Failed to get events',
      details: error.message
    });
  }
});

// 5. Get Recently Provisioned Devices
router.get('/recent-devices', async (req, res) => {
  try {
    // Get the most recently informed devices
    const recentDevicesResponse = await fetchFromGenieAcs('/devices', {
      sort: JSON.stringify({ _lastInform: -1 }), // Sort by _lastInform descending
      limit: 5
    });
    
    // Map to required format
    const recentDevices = recentDevicesResponse.map((device, index) => {
      const id = device._id || `UNKNOWN-${index}`;
      const model = device._deviceId?._ProductClass || 'Unknown';
      const serial = device._deviceId?._SerialNumber || 'Unknown';
      
      // Format date (using _lastInform as proxy for provision date)
      let provisionDate = 'Unknown';
      if (device._lastInform) {
        const date = new Date(device._lastInform);
        provisionDate = date.toISOString().split('T')[0]; // YYYY-MM-DD format
      }
      
      return { id, model, serial, provisionDate };
    });
    
    res.json({ recentDevices });
  } catch (error) {
    console.error('Error getting recent devices:', error);
    res.status(500).json({
      error: 'Failed to get recent devices',
      details: error.message
    });
  }
});

// 6. Get RX Power Distribution
router.get('/rxpower', async (req, res) => {
  try {
    // Fetch all devices with rxpower projection
    const vpRxPower = await new Promise((resolve, reject) => {
      db.get('SELECT value FROM settings WHERE key = ?', ['vpRxPower'], (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.value : 'VirtualParameters.RXPower');
      });
    });
    
    const allDevicesResponse = await fetchFromGenieAcs('/devices', {
      projection: `_id,_deviceId._SerialNumber,_deviceId._ProductClass,${vpRxPower}`
    });
    
    // Process devices to extract RX power values
    const devices = allDevicesResponse.map(device => {
      // Get the RX power value from the virtual parameter
      let rxpower = null;
      const vpPath = vpRxPower.split('.');
      let current = device;
      
      for (const part of vpPath) {
        if (current && typeof current === 'object') {
          current = current[part];
        } else {
          break;
        }
      }
      
      if (current && current._value !== undefined) {
        rxpower = current._value;
      }
      
      return {
        _id: device._id,
        SerialNumber: device._deviceId?._SerialNumber || 'Unknown',
        productclass: device._deviceId?._ProductClass || 'Unknown',
        rxpower: rxpower
      };
    });
    
    // Calculate RX power distribution
    const rxPowerDistribution = getRxPowerDistribution(devices);
    
    res.json(rxPowerDistribution);
  } catch (error) {
    console.error('Error getting RX power distribution:', error);
    res.status(500).json({
      error: 'Failed to get RX power distribution',
      details: error.message
    });
  }
});

// 6. Get All Dashboard Data in one call
router.get('/', async (req, res) => {
  try {
    // Using lower level function to optimize the request flow
    const getOptimizedDashboardData = async () => {
      console.time('dashboard-data-fetch');
      
      // Get GenieACS URL once for all requests
      const baseUrl = await getGenieAcsUrl();
      const vpRxPower = await new Promise((resolve, reject) => {
        db.get('SELECT value FROM settings WHERE key = ?', ['vpRxPower'], (err, row) => {
          if (err) return reject(err);
          resolve(row ? row.value : 'VirtualParameters.RXPower');
        });
      });
      
      // Make a single request for all device data needed
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      
      // Setup all requests we need to make
      const devicesFetch = fetchFromGenieAcs('/devices', {
        projection: `_id,_deviceId._ProductClass,_deviceId._SerialNumber,_lastInform,${vpRxPower}`
      });
      
      const faultsFetch = fetchFromGenieAcs('/faults', {});
      const tasksFetch = fetchFromGenieAcs('/tasks', {});
      
      // Execute all requests in parallel
      console.time('api-parallel-requests');
      const [allDevicesResponse, faultsResponse, tasksResponse] = await Promise.all([
        devicesFetch, 
        faultsFetch, 
        tasksFetch
      ]);
      console.timeEnd('api-parallel-requests');
      
      // Process metrics data
      console.time('process-metrics');
      const totalDevices = allDevicesResponse.length;
      
      const onlineDevices = allDevicesResponse.filter(device => {
        const lastInform = device._lastInform;
        return lastInform && new Date(lastInform) > tenMinutesAgo;
      }).length;
      
      const offlineDevices = totalDevices - onlineDevices;
      const faults = faultsResponse.length;
      
      // Calculate percentage changes (mock data for now)
      const totalChange = Math.round((Math.random() * 20) - 10);
      const onlineChange = Math.round((Math.random() * 16) - 8);
      const offlineChange = Math.round((Math.random() * 14) - 7);
      const faultsChange = Math.round((Math.random() * 10) - 5);
      
      const metrics = [
        { name: "Total Devices", value: totalDevices, status: totalChange >= 0 ? "up" : "down", change: totalChange },
        { name: "Online", value: onlineDevices, status: onlineChange >= 0 ? "up" : "down", change: onlineChange },
        { name: "Offline", value: offlineDevices, status: offlineChange <= 0 ? "up" : "down", change: offlineChange },
        { name: "Faults", value: faults, status: faultsChange <= 0 ? "up" : "warning", change: faultsChange }
      ];
      console.timeEnd('process-metrics');
      
      // Process connection types data
      console.time('process-connection-types');
      const productClasses = {};
      allDevicesResponse.forEach(device => {
        let productClass = 'Unknown';
        
        if (device?._deviceId?._ProductClass?._value) {
          productClass = device._deviceId._ProductClass._value;
        } else if (device?._deviceId?._ProductClass) {
          productClass = device._deviceId._ProductClass;
        }
        
        if (!productClasses[productClass]) {
          productClasses[productClass] = 0;
        }
        productClasses[productClass]++;
      });
      
      const connectionTypes = Object.entries(productClasses)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
        
      const labels = connectionTypes.map(type => type.name);
      const values = connectionTypes.map(type => type.value);
      
      const baseColors = [
        '#4B72B0', '#BF6F50', '#55A868', '#C44E52', '#8172B0', 
        '#BA68C8', '#4FC3F7', '#FFB74D', '#81C784', '#FF8A65', 
        '#9575CD', '#4DD0E1', '#FFF176', '#A1887F'
      ];
      
      const colors = Array.from({ length: connectionTypes.length }, 
        (_, i) => baseColors[i % baseColors.length]);
      
      const totalDevicesCount = connectionTypes.reduce((sum, type) => sum + type.value, 0);
      
      const connectionTypesChartData = {
        labels,
        series: [{ name: "Devices", data: values }],
        colors,
        totalDevices: totalDevicesCount
      };
      console.timeEnd('process-connection-types');
      
      // Process RX Power data
      console.time('process-rxpower');
      const devices = allDevicesResponse.map(device => {
        let rxpower = null;
        const vpPath = vpRxPower.split('.');
        let current = device;
        
        for (const part of vpPath) {
          if (current && typeof current === 'object') {
            current = current[part];
          } else {
            break;
          }
        }
        
        if (current && current._value !== undefined) {
          rxpower = current._value;
        }
        
        return {
          _id: device._id,
          SerialNumber: device._deviceId?._SerialNumber || 'Unknown',
          productclass: device._deviceId?._ProductClass || 'Unknown',
          rxpower: rxpower
        };
      });
      
      const rxPowerDistribution = getRxPowerDistribution(devices);
      console.timeEnd('process-rxpower');
      
      // Process events data
      console.time('process-events');
      const taskCounts = {};
      tasksResponse.forEach(task => {
        const name = task.name || 'Unknown';
        if (!taskCounts[name]) {
          taskCounts[name] = 0;
        }
        taskCounts[name]++;
      });
      
      const events = Object.entries(taskCounts)
        .map(([event, count], id) => ({ id: id + 1, event, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      
      if (events.length < 5) {
        const defaultEvents = [
          { id: 1, event: "Device Boot", count: 0 },
          { id: 2, event: "Periodic Inform", count: 0 },
          { id: 3, event: "Value Change", count: 0 },
          { id: 4, event: "Connection Request", count: 0 },
          { id: 5, event: "Diagnostics Complete", count: 0 }
        ];
        
        for (let i = events.length; i < 5; i++) {
          events.push(defaultEvents[i]);
        }
      }
      console.timeEnd('process-events');
      
      // Process recent devices data
      console.time('process-recent-devices');
      const sortedDevices = [...allDevicesResponse].sort((a, b) => {
        const dateA = a._lastInform ? new Date(a._lastInform) : new Date(0);
        const dateB = b._lastInform ? new Date(b._lastInform) : new Date(0);
        return dateB - dateA;
      }).slice(0, 5);
      
      const recentDevices = sortedDevices.map((device, index) => {
        const id = device._id || `UNKNOWN-${index}`;
        const model = device._deviceId?._ProductClass || 'Unknown';
        const serial = device._deviceId?._SerialNumber || 'Unknown';
        
        let provisionDate = 'Unknown';
        if (device._lastInform) {
          const date = new Date(device._lastInform);
          provisionDate = date.toISOString().split('T')[0]; // YYYY-MM-DD format
        }
        
        return { id, model, serial, provisionDate };
      });
      console.timeEnd('process-recent-devices');
      
      // Generate connection history (this is mock data)
      console.time('process-connection-history');
      const days = [];
      const connectionsData = [];
      const disconnectionsData = [];
      
      for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
        days.push(dayName);
        connectionsData.push(Math.floor(Math.random() * 150) + 50);
        disconnectionsData.push(Math.floor(Math.random() * 50) + 20);
      }
      
      const connectionHistory = {
        labels: days,
        series: [
          { name: "Connections", data: connectionsData },
          { name: "Disconnections", data: disconnectionsData }
        ]
      };
      console.timeEnd('process-connection-history');
      
      // Combine all data
      console.timeEnd('dashboard-data-fetch');
      
      return {
        metrics,
        connectionHistory,
        connectionTypes,
        connectionTypesChart: connectionTypesChartData,
        events,
        recentDevices,
        rxPowerDistribution
      };
    };
    // Execute the optimized data fetching
    const startTime = Date.now();
    
    try {
      const dashboardData = await getOptimizedDashboardData();
      
      const endTime = Date.now();
      
      // Return the data
      res.json(dashboardData);
    } catch (error) {
      console.error('Error in optimized dashboard data fetch:', error);
      
      // Fallback to basic mock data in case of error
      const mockData = {
        metrics: [
          { name: "Total Devices", value: 0, status: "down", change: 0 },
          { name: "Online", value: 0, status: "down", change: 0 },
          { name: "Offline", value: 0, status: "down", change: 0 },
          { name: "Faults", value: 0, status: "down", change: 0 }
        ],
        connectionHistory: {
          labels: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
          series: [
            { name: "Connections", data: [50, 60, 55, 70, 65, 80, 75] },
            { name: "Disconnections", data: [20, 25, 22, 30, 28, 35, 32] }
          ]
        },
        connectionTypes: [
          { name: "Unknown", value: 0 }
        ],
        connectionTypesChart: {
          labels: ["Unknown"],
          series: [{ name: "Devices", data: [0] }],
          colors: ['#4B72B0']
        },
        events: [
          { id: 1, event: "Device Boot", count: 0 },
          { id: 2, event: "Periodic Inform", count: 0 },
          { id: 3, event: "Value Change", count: 0 },
          { id: 4, event: "Connection Request", count: 0 },
          { id: 5, event: "Diagnostics Complete", count: 0 }
        ],
        recentDevices: [
          { id: "N/A", model: "N/A", serial: "N/A", provisionDate: "N/A" }
        ],
        rxPowerDistribution: {
          labels: ["Excellent", "Fair", "Poor", "N/A"],
          series: [0, 0, 0, 1],
          colors: ["#10B981", "#FBBF24", "#EF4444", "#9CA3AF"]
        }
      };
      
      res.json(mockData);
    }
  } catch (error) {
    console.error('Error getting dashboard data:', error);
    res.status(500).json({
      error: 'Failed to get dashboard data',
      details: error.message
    });
  }
});

export default router;
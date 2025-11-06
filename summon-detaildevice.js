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
 * Get all vendor configurations from database
 */
async function getVendorConfigurations() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all('SELECT * FROM vendors WHERE enabled = 1 ORDER BY priority DESC', [], (err, rows) => {
      db.close();
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

/**
 * Summon parameters for detail device view
 * This will refresh all parameters needed for device detail page
 * 
 * The implementation dynamically reads vendor configurations from the database
 * and requests appropriate vendor-specific parameters for each vendor.
 * This avoids hardcoding vendor parameters and makes the system more flexible
 * when new vendors are added.
 * 
 * POST /api/summon-detaildevice/:deviceId
 * Body: {
 *   parameters: ['wifi', 'wan', 'virtual', 'system', 'hosts', 'credentials'] // optional, default all
 * }
 */
router.post('/:deviceId', async (req, res) => {
  try {
    // Express auto-decodes URL params
    // Use decoded device ID directly (same approach as summon-device)
    const { deviceId } = req.params;
    const { 
      parameters = ['wifi', 'wan', 'virtual', 'system', 'hosts', 'credentials'],
      // Izinkan client untuk mengirim vendor yang terdeteksi agar lebih efisien
      detectedVendorPrefix = null 
    } = req.body;

    if (!deviceId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Device ID is required' 
      });
    }

    const settings = await getSettings();
    const baseUrl = settings.genieAcsUrl;

    if (!baseUrl) {
      return res.status(500).json({ 
        success: false, 
        message: 'GenieACS URL not configured' 
      });
    }
    
    // Get vendor configurations from database
    const vendorConfigurations = await getVendorConfigurations();
    
    // Filter vendor configurations based on detected prefix (jika ada)
    // Ini memungkinkan kita hanya meminta parameter yang relevan untuk vendor device yang sedang dilihat
    const relevantVendors = detectedVendorPrefix 
      ? vendorConfigurations.filter(v => v.parameter_prefix === detectedVendorPrefix)
      : vendorConfigurations;
    
    if (detectedVendorPrefix && relevantVendors.length > 0) {
    } else if (detectedVendorPrefix) {
    }
    
    // Clean up vendor configurations to remove parameter prefix duplications
    relevantVendors.forEach(vendor => {
      if (!vendor.parameter_prefix) return;
      
      // Fix common issues with path definitions in the database
      const prefix = vendor.parameter_prefix;
      
      // If vlan_id_path starts with the prefix, remove the prefix
      if (vendor.vlan_id_path && vendor.vlan_id_path.startsWith(`${prefix}_`)) {
        vendor.vlan_id_path = vendor.vlan_id_path.substring(prefix.length + 1);
      }
      
      // If service_list_path starts with the prefix, remove the prefix
      if (vendor.service_list_path && vendor.service_list_path.startsWith(`${prefix}_`)) {
        vendor.service_list_path = vendor.service_list_path.substring(prefix.length + 1);
      }
      
      // If lan_binding_path starts with the prefix, remove the prefix
      if (vendor.lan_binding_path && vendor.lan_binding_path.startsWith(`${prefix}_`)) {
        vendor.lan_binding_path = vendor.lan_binding_path.substring(prefix.length + 1);
      }
    });

    // Virtual Parameters from settings
    const vpPppoeUsername = settings.vpPppoeUsername || 'VirtualParameters.pppoeUsername';
    const vpWanBridge = settings.vpWanBridge || 'VirtualParameters.wanBridge';
    const vpRxPower = settings.vpRxPower || 'VirtualParameters.RXPower';
    const vpTemperature = settings.vpTemperature || 'VirtualParameters.gettemp';
    const vpActiveDevices = settings.vpActiveDevices || 'VirtualParameters.activedevices';
    const vpSuperAdmin = settings.vpSuperAdmin || 'VirtualParameters.superAdmin';
    const vpSuperPassword = settings.vpSuperPassword || 'VirtualParameters.superPassword';
    const vpUserAdmin = settings.vpUserAdmin || 'VirtualParameters.userAdmin';
    const vpUserPassword = settings.vpUserPassword || 'VirtualParameters.userPassword';

    const summonsToSend = [];
    const timestamp = Date.now();

    // Virtual Parameters
    if (parameters.includes('virtual')) {
      summonsToSend.push(
        { name: vpPppoeUsername, timestamp },
        { name: vpWanBridge, timestamp },
        { name: vpRxPower, timestamp },
        { name: vpTemperature, timestamp },
        { name: vpActiveDevices, timestamp },
        { name: vpSuperAdmin, timestamp },
        { name: vpSuperPassword, timestamp },
        { name: vpUserAdmin, timestamp },
        { name: vpUserPassword, timestamp }
      );
    }

    // System Information
    if (parameters.includes('system')) {
      summonsToSend.push(
        { name: 'InternetGatewayDevice.DeviceInfo.HardwareVersion', timestamp },
        { name: 'InternetGatewayDevice.DeviceInfo.SoftwareVersion', timestamp },
        { name: 'InternetGatewayDevice.DeviceInfo.UpTime', timestamp },
        { name: 'InternetGatewayDevice.ManagementServer.ConnectionRequestURL', timestamp },
        { name: 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress', timestamp }
      );
    }

    // WiFi Configuration (1-8)
    if (parameters.includes('wifi')) {
      // Karena beberapa device mendukung hingga 8 SSID
      const maxWifiConfig = settings.maxWifiConfig ? parseInt(settings.maxWifiConfig) : 8;
      for (let i = 1; i <= maxWifiConfig; i++) {
        summonsToSend.push(
          { name: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Enable`, timestamp },
          { name: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.SSID`, timestamp },
          { name: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.BeaconType`, timestamp },
          { name: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.TotalAssociations`, timestamp },
          { name: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Channel`, timestamp },
          { name: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.KeyPassphrase`, timestamp },
          { name: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.PreSharedKey.1.KeyPassphrase`, timestamp }
        );
      }
      
      // WiFi Clients
      summonsToSend.push(
        { name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.*.AssociatedDevice.*', timestamp }
      );
    }

    // Hosts (Active Device List) - LAN Connected Devices
    if (parameters.includes('hosts')) {
      summonsToSend.push(
        { name: 'InternetGatewayDevice.LANDevice.1.Hosts.Host', timestamp },
        { name: vpActiveDevices, timestamp }
      );
    }

    // Credentials (Admin Passwords) - For System Tab
    if (parameters.includes('credentials')) {
      summonsToSend.push(
        { name: vpSuperAdmin, timestamp },
        { name: vpSuperPassword, timestamp },
        { name: vpUserAdmin, timestamp },
        { name: vpUserPassword, timestamp }
      );
    }

    // Security Parameters (Firewall, HTTP WAN Access) - From Vendor Database
    if (parameters.includes('system-credentials') || parameters.includes('credentials')) {
      relevantVendors.forEach(vendor => {
        // HTTP WAN Enable
        if (vendor.http_wan_enable_path) {
          summonsToSend.push({
            name: vendor.http_wan_enable_path,
            timestamp
          });
        }
        
        // Firewall Level
        if (vendor.firewall_level_path) {
          summonsToSend.push({
            name: vendor.firewall_level_path,
            timestamp
          });
        }
      });
    }

    // WAN Connections
    if (parameters.includes('wan')) {
      // Standard WAN parameters (always include these)
      const standardWanParams = [
        // WAN IP Connection
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.Enable', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.ConnectionStatus', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.ExternalIPAddress', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.SubnetMask', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.DefaultGateway', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.DNSServers', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.ConnectionType', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.Name', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.NATEnabled', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.AddressingType', timestamp },
        
        // WAN PPP Connection
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Enable', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ConnectionStatus', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.DNSServers', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ConnectionType', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Name', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.NATEnabled', timestamp },
        { name: 'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.LastConnectionError', timestamp }
      ];
      
      summonsToSend.push(...standardWanParams);
      
      // Add vendor-specific parameters for each relevant vendor
      relevantVendors.forEach(vendor => {
        // Skip if no parameter prefix
        if (!vendor.parameter_prefix) return;
        
        const prefix = vendor.parameter_prefix;
        
        // Add vendor-specific WAN IP Connection parameters
        if (vendor.vlan_id_path) {
          const paramPath = vendor.vlan_id_path.startsWith(`${prefix}_`) 
            ? vendor.vlan_id_path     // Jika path sudah mengandung prefix, gunakan as-is
            : `${prefix}_${vendor.vlan_id_path}`; // Jika belum, tambahkan prefix
          
          if (prefix === 'X_CT-COM') {
            summonsToSend.push({ 
              name: `InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.${paramPath}`, 
              timestamp 
            });
          } else {
            // Vendor lain (Huawei, FiberHome, CMCC) menggunakan struktur normal
            summonsToSend.push({ 
              name: `InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.${paramPath}`, 
              timestamp 
            });
          }
        }
        
        if (vendor.service_list_path) {
          // Service list path - cegah duplikasi prefix
          const serviceListPath = vendor.service_list_path.startsWith(`${prefix}_`)
            ? vendor.service_list_path
            : `${prefix}_${vendor.service_list_path}`;
          
          // Service list path selalu berada di level WANIPConnection untuk semua vendor
          summonsToSend.push({ 
            name: `InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.${serviceListPath}`, 
            timestamp 
          });
        }
        
        if (vendor.lan_binding_path) {
          // LAN binding path - cegah duplikasi prefix
          const lanBindingPath = vendor.lan_binding_path.startsWith(`${prefix}_`)
            ? vendor.lan_binding_path
            : `${prefix}_${vendor.lan_binding_path}`;
          
          // LAN binding path selalu berada di level WANIPConnection untuk semua vendor
          summonsToSend.push({ 
            name: `InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.${lanBindingPath}`, 
            timestamp 
          });
        }
        
        // Add vendor-specific WAN PPP Connection parameters
        if (vendor.vlan_id_path) {
          // Hapus penambahan VlanMuxID karena tidak ada device dengan path ini
          
          // VLAN ID path for PPP - cegah duplikasi prefix
          const pppVlanPath = vendor.vlan_id_path.startsWith(`${prefix}_`)
            ? vendor.vlan_id_path
            : `${prefix}_${vendor.vlan_id_path}`;
          
          // Khusus untuk X_CT-COM, path parameter berada di level WANConnectionDevice, bukan WANPPPConnection
          // Ini berlaku untuk semua parameter dari vendor CT-COM
          if (prefix === 'X_CT-COM') {
            summonsToSend.push({ 
              name: `InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.${pppVlanPath}`, 
              timestamp 
            });
          } else {
            // Vendor lain (Huawei, FiberHome, CMCC) menggunakan struktur normal
            summonsToSend.push({ 
              name: `InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.${pppVlanPath}`, 
              timestamp 
            });
          }
        }
        
        if (vendor.service_list_path) {
          // Service list path for PPP - cegah duplikasi prefix
          const pppServicePath = vendor.service_list_path.startsWith(`${prefix}_`)
            ? vendor.service_list_path
            : `${prefix}_${vendor.service_list_path}`;
          
          // Service list path selalu berada di level WANPPPConnection untuk semua vendor
          summonsToSend.push({ 
            name: `InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.${pppServicePath}`, 
            timestamp 
          });
        }
        
        if (vendor.lan_binding_path) {
          // LAN binding path for PPP - cegah duplikasi prefix
          const pppLanPath = vendor.lan_binding_path.startsWith(`${prefix}_`)
            ? vendor.lan_binding_path
            : `${prefix}_${vendor.lan_binding_path}`;
          
          // LAN binding path selalu berada di level WANPPPConnection untuk semua vendor
          summonsToSend.push({ 
            name: `InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.${pppLanPath}`, 
            timestamp 
          });
        }
      });
      
      // X_CU_LanInterface telah dihapus karena sekarang seharusnya diambil dari database vendor
    }

    const encodedDeviceId = encodeURIComponent(deviceId);
    const summonUrl = `${baseUrl}/${encodedDeviceId}/tasks?connection_request`;

    try {
      // For debugging - list all vendor-specific parameters being requested
      if (settings.debug === 'true' || settings.debug === '1') {
        const vendorSpecificParams = summonsToSend
          .map(s => s.name)
          .filter(name => {
            return vendorConfigurations.some(vendor => 
              vendor.parameter_prefix && name.includes(vendor.parameter_prefix)
            );
          });
      }
      
      const response = await axios.post(
        summonUrl,
        { 
          name: 'getParameterValues',
          parameterNames: summonsToSend.map(s => s.name)
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000 // 30 seconds timeout
        }
      );

      return res.json({
        success: true,
        message: `Summon sent successfully for ${summonsToSend.length} parameters`,
        deviceId,
        parameterTypes: parameters,
        parameterCount: summonsToSend.length,
        taskId: response.data._id || 'unknown',
        vendorInfo: detectedVendorPrefix ? {
          prefix: detectedVendorPrefix,
          configFound: relevantVendors.length > 0,
          vendor: relevantVendors.length > 0 ? relevantVendors[0].name : null
        } : {
          message: 'No specific vendor provided, using all vendor configurations'
        }
      });

    } catch (genieError) {
      console.error('GenieACS summon error:', genieError.message);
      
      if (genieError.response) {
        return res.status(genieError.response.status).json({
          success: false,
          message: 'GenieACS returned an error',
          error: genieError.response.data,
          statusCode: genieError.response.status
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to send summon to GenieACS',
        error: genieError.message
      });
    }

  } catch (error) {
    console.error('Summon detail device error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

export default router;

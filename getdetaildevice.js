import axios from 'axios';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import * as vendorConfig from './vendor-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'database.sqlite');

/**
 * Get settings from database
 * @returns {Promise<Object>} - Settings object
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
 * @returns {Promise<Array>} - Array of vendor configurations
 */
async function getVendorConfigurations() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all('SELECT * FROM vendors WHERE enabled = 1', [], (err, rows) => {
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
 * Get detailed device information from GenieACS
 * @param {string} deviceId - Device ID to fetch details for
 * @returns {Promise<Object>} - Detailed device information
 */
async function getDetailDevice(deviceId) {
  if (!deviceId) {
    throw new Error('Device ID is required');
  }

  const settings = await getSettings();
  const baseUrl = settings.genieAcsUrl;

  if (!baseUrl) {
    throw new Error('GenieACS URL not configured in settings');
  }

  // Get Virtual Parameters from settings
  const vpPppoeUsername = settings.vpPppoeUsername || 'VirtualParameters.pppoeUsername';
  const vpWanBridge = settings.vpWanBridge || 'VirtualParameters.wanBridge';
  const vpRxPower = settings.vpRxPower || 'VirtualParameters.RXPower';
  const vpTemperature = settings.vpTemperature || 'VirtualParameters.gettemp';
  const vpActiveDevices = settings.vpActiveDevices || 'VirtualParameters.activedevices';
  const vpSuperAdmin = settings.vpSuperAdmin || 'VirtualParameters.superAdmin';
  const vpSuperPassword = settings.vpSuperPassword || 'VirtualParameters.superPassword';
  const vpUserAdmin = settings.vpUserAdmin || 'VirtualParameters.userAdmin';
  const vpUserPassword = settings.vpUserPassword || 'VirtualParameters.userPassword';

  // Get all vendor configurations to include their security parameters
  const vendorConfigurations = await getVendorConfigurations();

  // Projection untuk parameter yang dibutuhkan
  const projection = [
    '_id',
    '_deviceId._ProductClass',
    '_deviceId._SerialNumber',
    '_deviceId._Manufacturer',
    '_deviceId._OUI',
    vpPppoeUsername,
    vpWanBridge,
    vpRxPower,
    vpTemperature,
    vpActiveDevices,
    vpSuperAdmin,
    vpSuperPassword,
    vpUserAdmin,
    vpUserPassword,
    // WiFi parameters
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BeaconType',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Enable',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.PreSharedKey.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.BeaconType',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Channel',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.Enable',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.PreSharedKey.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.BeaconType',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.Channel',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.Enable',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.PreSharedKey.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.BeaconType',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.Channel',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Enable',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.BeaconType',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Channel',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Enable',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.PreSharedKey.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.BeaconType',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Channel',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.Enable',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.PreSharedKey.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.BeaconType',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.Channel',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.Enable',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.PreSharedKey.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.BeaconType',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.Channel',
    // Device Info
    'InternetGatewayDevice.DeviceInfo.HardwareVersion',
    'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
    'InternetGatewayDevice.DeviceInfo.UpTime',
    // MAC Address
    'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress',
    'InternetGatewayDevice.WANDevice.1.WANEthernetInterfaceConfig.MACAddress',
    // WAN Device structure
    'InternetGatewayDevice.WANDevice',
    '_lastInform',
    '_lastBoot',
    '_registered',
    'InternetGatewayDevice.LANDevice.1.Hosts.Host'
  ];

  // Add vendor-specific security parameters to projection
  vendorConfigurations.forEach(vendor => {
    if (vendor.http_wan_enable_path) {
      projection.push(vendor.http_wan_enable_path);
    }
    if (vendor.firewall_level_path) {
      projection.push(vendor.firewall_level_path);
    }
  });

  // Build query URL
  const query = JSON.stringify({ _id: deviceId });
  const apiUrl = `${baseUrl}?query=${encodeURIComponent(query)}&projection=${encodeURIComponent(projection.join(','))}`;

  try {
    // Fetch data from GenieACS
    const response = await axios.get(apiUrl, {
      timeout: 15000,
      headers: {
        'Accept-Encoding': 'gzip'
      }
    });

    const data = response.data;

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Device not found');
    }

    // Process device data
    const item = data[0];
    
    // Helper function to extract VP value from dynamic path
    const getVPValue = (vpPath) => {
      if (!vpPath || !item.VirtualParameters) return null;
      const paramName = vpPath.split('.').pop(); // Get last part after dot
      return item.VirtualParameters[paramName]?._value || null;
    };

    // Extract Virtual Parameters using dynamic paths from settings
    const pppoeUsernameValue = getVPValue(vpPppoeUsername);
    const wanBridgeValue = getVPValue(vpWanBridge);
    const rxpowerValue = getVPValue(vpRxPower);
    const temperatureValue = getVPValue(vpTemperature);
    const activedevicesValue = getVPValue(vpActiveDevices);
    const superAdminValue = getVPValue(vpSuperAdmin);
    const superPasswordValue = getVPValue(vpSuperPassword);
    const userAdminValue = getVPValue(vpUserAdmin);
    const userPasswordValue = getVPValue(vpUserPassword);

    // Timestamps
    const _lastInformUTC = item._lastInform || null;
    const _lastBootUTC = item._lastBoot || null;
    const _registered = item._registered || null;

    // Device ID info
    const deviceIdInfo = item._deviceId || {};
    const typeont = deviceIdInfo._ProductClass || null;
    const serialNumber = deviceIdInfo._SerialNumber || null;
    const manufacturer = deviceIdInfo._Manufacturer || null;
    const oui = deviceIdInfo._OUI || null;

    // Detect vendor using simplified database-driven config
    // Pass device data for accurate prefix-based detection
    // Now returns complete vendor info with all parameter paths!
    const vendorObj = await vendorConfig.detectVendor(manufacturer, typeont, item);
    const vendor = vendorObj ? vendorObj.name.toLowerCase() : 'unknown';
    const vendorId = vendorObj ? vendorObj.id : null;

    // Device Info
    const hardwareVersion = item.InternetGatewayDevice?.DeviceInfo?.HardwareVersion?._value || null;
    const softwareVersion = item.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion?._value || null;
    const upTime = item.InternetGatewayDevice?.DeviceInfo?.UpTime?._value || null;

    // MAC Address
    const deviceMacAddress = 
      item.InternetGatewayDevice?.LANDevice?.['1']?.LANEthernetInterfaceConfig?.['1']?.MACAddress?._value ||
      item.InternetGatewayDevice?.WANDevice?.['1']?.WANEthernetInterfaceConfig?.MACAddress?._value ||
      null;

    // Process WAN Connections
    const wanDevices = item.InternetGatewayDevice?.WANDevice || {};
    const cleanedWanDevices = cleanGenieACSData(wanDevices);
    const wanConnections = await processWANConnections(cleanedWanDevices, item, vendorObj);

    // Filter by type
    const wanIPConnections = wanConnections.filter(conn => conn.type === 'WANIPConnection');
    const wanPPPConnections = wanConnections.filter(conn => conn.type === 'WANPPPConnection');

    // Process WiFi Configurations
    const wifiConfigurations = await processWiFiConfigurations(item, vendor, vendorId);

    // Process WiFi Clients
    const wifiClients = processWiFiClients(item);

    // Format timestamps to WIB (Asia/Jakarta)
    const _lastInformWIB = formatToWIB(_lastInformUTC);
    const _lastBootWIB = formatToWIB(_lastBootUTC);
    const _registeredWIB = formatToWIB(_registered);

    // Build detailed output
    const output = {
      _id: deviceId,
      vendor: vendor,
      deviceInfo: {
        productclass: typeont,
        serialNumber: serialNumber,
        manufacturer: manufacturer,
        oui: oui,
        hardwareVersion: hardwareVersion,
        softwareVersion: softwareVersion,
        upTime: upTime,
        macAddress: deviceMacAddress
      },
      connectionInfo: {
        _lastInform: _lastInformWIB,
        _lastBoot: _lastBootWIB,
        _registered: _registeredWIB
      },
      wanConnections: {
        wanIPConnections: wanIPConnections,
        wanPPPConnections: wanPPPConnections,
        totalConnections: wanConnections.length,
        totalIPConnections: wanIPConnections.length,
        totalPPPConnections: wanPPPConnections.length,
        debugInfo: {
          wanDevicesFound: Object.keys(cleanedWanDevices),
          vendor: vendor,
          wanDevicesCount: Object.keys(cleanedWanDevices).length
        }
      },
      wifiInfo: wifiConfigurations,
      wifiClients: wifiClients,
      virtualParameters: {
        pppoeUsername: {
          path: vpPppoeUsername,
          value: pppoeUsernameValue
        },
        wanBridge: {
          path: vpWanBridge,
          value: wanBridgeValue
        },
        rxpower: {
          path: vpRxPower,
          value: rxpowerValue
        },
        temperature: {
          path: vpTemperature,
          value: temperatureValue
        },
        activedevices: {
          path: vpActiveDevices,
          value: activedevicesValue
        },
        superAdmin: {
          path: vpSuperAdmin,
          value: superAdminValue
        },
        superPassword: {
          path: vpSuperPassword,
          value: superPasswordValue
        },
        userAdmin: {
          path: vpUserAdmin,
          value: userAdminValue
        },
        userPassword: {
          path: vpUserPassword,
          value: userPasswordValue
        }
      },
      securityInfo: await createSecurityInfo(vendorObj, item),
      vendorDetection: {
        vendor: vendor,
        vendorId: vendorId,
        vendorName: vendorObj?.name || 'Unknown',
        parameterPrefix: vendorObj?.parameter_prefix || null
      }
    };

    return output;

  } catch (error) {
    if (error.response) {
      throw new Error(`GenieACS API error: ${error.response.status} - ${error.response.statusText}`);
    } else if (error.request) {
      throw new Error('No response from GenieACS server');
    } else {
      throw error;
    }
  }
}

// Note: detectVendor function now uses database-driven vendorConfig.detectVendor() instead of hardcoded logic

// Helper function: Clean GenieACS metadata
function cleanGenieACSData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => cleanGenieACSData(item));
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(data)) {
    // Skip metadata
    if (['_object', '_writable', '_timestamp', '_type', '_instance'].includes(key)) {
      continue;
    }

    cleaned[key] = cleanGenieACSData(value);
  }

  return cleaned;
}

// Helper function: Process WAN Connections (simplified - no more complex DB queries!)
async function processWANConnections(wanDevices, item, vendorObj) {
  const wanConnections = [];

  for (const [wanDeviceIndex, wanDevice] of Object.entries(wanDevices)) {
    if (wanDevice.WANConnectionDevice) {
      for (const [connDeviceIndex, connDevice] of Object.entries(wanDevice.WANConnectionDevice)) {
        
        // Process WANIPConnection
        if (connDevice.WANIPConnection) {
          for (const [ipConnIndex, ipConn] of Object.entries(connDevice.WANIPConnection)) {
            const basePath = `InternetGatewayDevice.WANDevice.${wanDeviceIndex}.WANConnectionDevice.${connDeviceIndex}.WANIPConnection.${ipConnIndex}`;
            
            wanConnections.push({
              type: 'WANIPConnection',
              path: basePath,
              wanDeviceIndex,
              connDeviceIndex,
              index: ipConnIndex,
              enable: { path: `${basePath}.Enable`, value: ipConn.Enable?._value || null },
              connectionStatus: { path: `${basePath}.ConnectionStatus`, value: ipConn.ConnectionStatus?._value || null },
              externalIPAddress: { path: `${basePath}.ExternalIPAddress`, value: ipConn.ExternalIPAddress?._value || null },
              subnetMask: { path: `${basePath}.SubnetMask`, value: ipConn.SubnetMask?._value || null },
              defaultGateway: { path: `${basePath}.DefaultGateway`, value: ipConn.DefaultGateway?._value || null },
              dnsServers: { path: `${basePath}.DNSServers`, value: ipConn.DNSServers?._value || null },
              connectionType: { path: `${basePath}.ConnectionType`, value: ipConn.ConnectionType?._value || null },
              name: { path: `${basePath}.Name`, value: ipConn.Name?._value || null },
              natEnabled: { path: `${basePath}.NATEnabled`, value: ipConn.NATEnabled?._value || null },
              addressingType: { path: `${basePath}.AddressingType`, value: ipConn.AddressingType?._value || null },
              serviceList: createServiceList(vendorObj, ipConn, basePath),
              lanBinding: createLanBinding(vendorObj, ipConn, basePath),
              vlanInfo: createVlanInfo(vendorObj, ipConn, connDevice, wanDeviceIndex, connDeviceIndex, basePath)
            });
          }
        }

        // Process WANPPPConnection
        if (connDevice.WANPPPConnection) {
          for (const [pppConnIndex, pppConn] of Object.entries(connDevice.WANPPPConnection)) {
            const basePath = `InternetGatewayDevice.WANDevice.${wanDeviceIndex}.WANConnectionDevice.${connDeviceIndex}.WANPPPConnection.${pppConnIndex}`;
            
            wanConnections.push({
              type: 'WANPPPConnection',
              path: basePath,
              wanDeviceIndex,
              connDeviceIndex,
              index: pppConnIndex,
              enable: { path: `${basePath}.Enable`, value: pppConn.Enable?._value || null },
              connectionStatus: { path: `${basePath}.ConnectionStatus`, value: pppConn.ConnectionStatus?._value || null },
              externalIPAddress: { path: `${basePath}.ExternalIPAddress`, value: pppConn.ExternalIPAddress?._value || null },
              username: { path: `${basePath}.Username`, value: getPPPUsername(item, wanDeviceIndex, connDeviceIndex, pppConnIndex) },
              dnsServers: { path: `${basePath}.DNSServers`, value: pppConn.DNSServers?._value || null },
              connectionType: { path: `${basePath}.ConnectionType`, value: pppConn.ConnectionType?._value || null },
              name: { path: `${basePath}.Name`, value: pppConn.Name?._value || null },
              natEnabled: { path: `${basePath}.NATEnabled`, value: pppConn.NATEnabled?._value || null },
              lastConnectionError: { path: `${basePath}.LastConnectionError`, value: pppConn.LastConnectionError?._value || null },
              serviceList: createServiceList(vendorObj, pppConn, basePath),
              lanBinding: createLanBinding(vendorObj, pppConn, basePath),
              vlanInfo: createVlanInfo(vendorObj, pppConn, connDevice, wanDeviceIndex, connDeviceIndex, basePath)
            });
          }
        }
      }
    }
  }

  return wanConnections;
}

// Helper function: Get PPP Username
function getPPPUsername(item, wanDeviceIndex, connDeviceIndex, pppConnIndex) {
  const parameterPath = `InternetGatewayDevice.WANDevice.${wanDeviceIndex}.WANConnectionDevice.${connDeviceIndex}.WANPPPConnection.${pppConnIndex}.Username`;
  
  if (item[parameterPath]?._value) {
    return item[parameterPath]._value;
  }

  // Fallback: nested structure
  return item.InternetGatewayDevice?.WANDevice?.[wanDeviceIndex]?.WANConnectionDevice?.[connDeviceIndex]?.WANPPPConnection?.[pppConnIndex]?.Username?._value || null;
}

// Helper function: Create Service List (simplified!)
function createServiceList(vendorObj, connection, basePath) {
  if (!vendorObj || !vendorObj.service_list_path) return null;

  const paramPath = vendorObj.service_list_path;
  const value = connection[paramPath]?._value;

  if (value) {
    return {
      serviceList: { path: `${basePath}.${paramPath}`, value: value }
    };
  }

  return null;
}

// Helper function: Create LAN Binding (normalized and simplified!)
function createLanBinding(vendorObj, connection, basePath) {
  if (!vendorObj || !vendorObj.lan_binding_path) return null;

  const paramPath = vendorObj.lan_binding_path;
  const lanBindObj = connection[paramPath];
  const fullPath = `${basePath}.${paramPath}`;
  
  // Initialize normalized binding (consistent for all vendors)
  const normalized = {
    lan1: false,
    lan2: false,
    lan3: false,
    lan4: false,
    ssid1: false,
    ssid2: false,
    ssid3: false,
    ssid4: false,
    ssid5: false,
    ssid6: false,
    ssid7: false,
    ssid8: false
  };
  
  // Raw data for debugging/advanced use
  const raw = {
    path: fullPath,
    vendor: vendorObj.name
  };
  
  if (lanBindObj && typeof lanBindObj === 'object') {
    // Check if it's an object with _value (ZTE string style wrapped in object)
    if (lanBindObj._value && typeof lanBindObj._value === 'string') {
      // ZTE style: Object with _value containing comma-separated string
      const value = lanBindObj._value;
      const interfaces = value.split(',').map(s => s.trim());
      
      interfaces.forEach(interfacePath => {
        // Check for LAN ports (LANEthernetInterfaceConfig.1 = lan1, .2 = lan2, etc)
        if (interfacePath.includes('LANEthernetInterfaceConfig')) {
          const match = interfacePath.match(/LANEthernetInterfaceConfig\.(\d+)/);
          if (match) {
            const portNum = parseInt(match[1]);
            if (portNum >= 1 && portNum <= 4) {
              normalized[`lan${portNum}`] = true;
            }
          }
        }
        
        // Check for WiFi SSIDs (WLANConfiguration.1 = ssid1, .2 = ssid2, etc)
        if (interfacePath.includes('WLANConfiguration')) {
          const match = interfacePath.match(/WLANConfiguration\.(\d+)/);
          if (match) {
            const ssidNum = parseInt(match[1]);
            if (ssidNum >= 1 && ssidNum <= 8) {
              normalized[`ssid${ssidNum}`] = true;
            }
          }
        }
      });
      
      // Store raw data
      raw.type = 'string';
      raw.data = value;
      raw.parsed = interfaces;
      
      return { path: fullPath, normalized, raw };
    }
    
    // Huawei style: X_HW_LANBIND with nested properties (Lan1Enable, SSID1Enable, etc)
    normalized.lan1 = lanBindObj.Lan1Enable?._value === 1 || lanBindObj.Lan1Enable?._value === '1' || lanBindObj.Lan1Enable?._value === true;
    normalized.lan2 = lanBindObj.Lan2Enable?._value === 1 || lanBindObj.Lan2Enable?._value === '1' || lanBindObj.Lan2Enable?._value === true;
    normalized.lan3 = lanBindObj.Lan3Enable?._value === 1 || lanBindObj.Lan3Enable?._value === '1' || lanBindObj.Lan3Enable?._value === true;
    normalized.lan4 = lanBindObj.Lan4Enable?._value === 1 || lanBindObj.Lan4Enable?._value === '1' || lanBindObj.Lan4Enable?._value === true;
    normalized.ssid1 = lanBindObj.SSID1Enable?._value === 1 || lanBindObj.SSID1Enable?._value === '1' || lanBindObj.SSID1Enable?._value === true;
    normalized.ssid2 = lanBindObj.SSID2Enable?._value === 1 || lanBindObj.SSID2Enable?._value === '1' || lanBindObj.SSID2Enable?._value === true;
    normalized.ssid3 = lanBindObj.SSID3Enable?._value === 1 || lanBindObj.SSID3Enable?._value === '1' || lanBindObj.SSID3Enable?._value === true;
    normalized.ssid4 = lanBindObj.SSID4Enable?._value === 1 || lanBindObj.SSID4Enable?._value === '1' || lanBindObj.SSID4Enable?._value === true;
    normalized.ssid5 = lanBindObj.SSID5Enable?._value === 1 || lanBindObj.SSID5Enable?._value === '1' || lanBindObj.SSID5Enable?._value === true;
    normalized.ssid6 = lanBindObj.SSID6Enable?._value === 1 || lanBindObj.SSID6Enable?._value === '1' || lanBindObj.SSID6Enable?._value === true;
    normalized.ssid7 = lanBindObj.SSID7Enable?._value === 1 || lanBindObj.SSID7Enable?._value === '1' || lanBindObj.SSID7Enable?._value === true;
    normalized.ssid8 = lanBindObj.SSID8Enable?._value === 1 || lanBindObj.SSID8Enable?._value === '1' || lanBindObj.SSID8Enable?._value === true;
    
    // Store raw data
    raw.type = 'object';
    raw.data = {
      Lan1Enable: lanBindObj.Lan1Enable?._value || null,
      Lan2Enable: lanBindObj.Lan2Enable?._value || null,
      Lan3Enable: lanBindObj.Lan3Enable?._value || null,
      Lan4Enable: lanBindObj.Lan4Enable?._value || null,
      SSID1Enable: lanBindObj.SSID1Enable?._value || null,
      SSID2Enable: lanBindObj.SSID2Enable?._value || null,
      SSID3Enable: lanBindObj.SSID3Enable?._value || null,
      SSID4Enable: lanBindObj.SSID4Enable?._value || null,
      SSID5Enable: lanBindObj.SSID5Enable?._value || null,
      SSID6Enable: lanBindObj.SSID6Enable?._value || null,
      SSID7Enable: lanBindObj.SSID7Enable?._value || null,
      SSID8Enable: lanBindObj.SSID8Enable?._value || null
    };
    
    return { path: fullPath, normalized, raw };
  }
  
  // ZTE/FiberHome style: Comma-separated string with interface paths
  const value = connection[paramPath]?._value;
  if (value && typeof value === 'string') {
    // Parse string like "InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1"
    const interfaces = value.split(',').map(s => s.trim());
    
    interfaces.forEach(interfacePath => {
      // Check for LAN ports (LANEthernetInterfaceConfig.1 = lan1, .2 = lan2, etc)
      if (interfacePath.includes('LANEthernetInterfaceConfig')) {
        const match = interfacePath.match(/LANEthernetInterfaceConfig\.(\d+)/);
        if (match) {
          const portNum = parseInt(match[1]);
          if (portNum >= 1 && portNum <= 4) {
            normalized[`lan${portNum}`] = true;
          }
        }
      }
      
      // Check for WiFi SSIDs (WLANConfiguration.1 = ssid1, .2 = ssid2, etc)
      if (interfacePath.includes('WLANConfiguration')) {
        const match = interfacePath.match(/WLANConfiguration\.(\d+)/);
        if (match) {
          const ssidNum = parseInt(match[1]);
          if (ssidNum >= 1 && ssidNum <= 8) {
            normalized[`ssid${ssidNum}`] = true;
          }
        }
      }
    });
    
    // Store raw data
    raw.type = 'string';
    raw.data = value;
    raw.parsed = interfaces;
    
    return { path: fullPath, normalized, raw };
  }

  return null;
}

// Helper function: Create VLAN Info (simplified!)
function createVlanInfo(vendorObj, connection, connDevice, wanDeviceIndex, connDeviceIndex, basePath) {
  if (!vendorObj || !vendorObj.vlan_id_path) return null;

  const paramPath = vendorObj.vlan_id_path;
  let value = null;
  let fullPath = '';
  
  // Strategy: Try connection level first, then device level
  // This works for all vendors without hardcoding specific path patterns
  
  // 1. Try connection-level parameter first (most common: Huawei, FiberHome)
  const pathParts = paramPath.split('.');
  let current = connection;
  
  for (const part of pathParts) {
    if (current && typeof current === 'object') {
      current = current[part];
    } else {
      current = null;
      break;
    }
  }
  
  if (current && current._value !== undefined && current._value !== null && current._value !== '' && current._value !== 0) {
    value = current._value;
    fullPath = `${basePath}.${paramPath}`;
  }
  
  // 2. If not found at connection level, try device level (ZTE variants with WANEponLinkConfig/WANGponLinkConfig)
  if (!value) {
    const pathParts = paramPath.split('.');
    let current = connDevice;
    
    for (const part of pathParts) {
      if (current && typeof current === 'object') {
        current = current[part];
      } else {
        current = null;
        break;
      }
    }
    
    if (current && current._value !== undefined && current._value !== null && current._value !== '' && current._value !== 0) {
      value = current._value;
      fullPath = `InternetGatewayDevice.WANDevice.${wanDeviceIndex}.WANConnectionDevice.${connDeviceIndex}.${paramPath}`;
    }
  }
  
  // 3. Fallback: Check for simple VLANID at device level (some FiberHome variants)
  if (!value && paramPath === 'VLANID' && connDevice?.VLANID?._value) {
    value = connDevice.VLANID._value;
    fullPath = `InternetGatewayDevice.WANDevice.${wanDeviceIndex}.WANConnectionDevice.${connDeviceIndex}.VLANID`;
  }
  
  // Return result if valid value found
  if (value !== null && value !== '' && value !== 0) {
    return {
      path: fullPath,
      value: value
    };
  }
  
  return null;
}

// Helper function: Create Security Info (simplified!)
function createSecurityInfo(vendorObj, item) {
  if (!vendorObj) return null;

  const securityData = {};
  
  // HTTP WAN Enable
  if (vendorObj.http_wan_enable_path) {
    const pathParts = vendorObj.http_wan_enable_path.split('.');
    let current = item;
    
    for (const part of pathParts) {
      if (current && typeof current === 'object') {
        current = current[part];
      } else {
        current = null;
        break;
      }
    }
    
    // Extract the actual value from GenieACS structure
    const actualValue = current?._value !== undefined ? current._value : null;
    
    securityData.httpWanEnable = {
      path: vendorObj.http_wan_enable_path,
      value: actualValue
    };
  }
  
  // Firewall Level
  if (vendorObj.firewall_level_path) {
    const pathParts = vendorObj.firewall_level_path.split('.');
    let current = item;
    
    for (const part of pathParts) {
      if (current && typeof current === 'object') {
        current = current[part];
      } else {
        current = null;
        break;
      }
    }
    
    // Extract the actual value from GenieACS structure
    const actualValue = current?._value !== undefined ? current._value : null;
    
    securityData.firewallLevel = {
      path: vendorObj.firewall_level_path,
      value: actualValue
    };
  }
  
  return Object.keys(securityData).length > 0 ? securityData : null;
}

// Helper function: Process WiFi Configurations (database-driven)
async function processWiFiConfigurations(item, vendor, vendorId) {
  const wifiConfigurations = {};

  // Get product class from device info
  const productClass = item._deviceId?.productClass || '';
  
  // Look up WiFi config based on product class
  let wifiConfig = null;
  if (productClass) {
    try {
      const sqlite3 = require('sqlite3').verbose();
      const database = new sqlite3.Database('./database.sqlite');
      
      wifiConfig = await new Promise((resolve, reject) => {
        database.get(
          'SELECT * FROM wifi_security_config WHERE LOWER(product_class) = LOWER(?)',
          [productClass],
          (err, row) => {
            database.close();
            if (err) reject(err);
            else resolve(row);
          }
        );
      });
    } catch (error) {
      console.error('Error fetching WiFi config:', error);
    }
  }

  for (let i = 1; i <= 8; i++) {
    const wlanConfig = item.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.[i] || {};

    const enabled = wlanConfig.Enable?._value || null;
    const ssidValue = wlanConfig.SSID?._value || null;
    const rawSecurity = wlanConfig.BeaconType?._value || null;
    const stations = wlanConfig.TotalAssociations?._value || null;
    const channel = wlanConfig.Channel?._value || null;

    // Normalize security value using WiFi config database mapping
    let normalizedSecurity = rawSecurity;
    if (wifiConfig && wifiConfig.security_types && rawSecurity) {
      try {
        const securityTypes = JSON.parse(wifiConfig.security_types);
        normalizedSecurity = securityTypes[rawSecurity] || rawSecurity;
      } catch (error) {
        console.error('Error parsing security types from WiFi config:', error);
        normalizedSecurity = rawSecurity; // Fallback to raw value
      }
    }

    // Get password using WiFi config from database
    let password = null;
    let passwordPath = '';

    if (wifiConfig && wifiConfig.password_param_path) {
      const paramPath = wifiConfig.password_param_path;
      
      if (paramPath.includes('PreSharedKey')) {
        // Huawei style: PreSharedKey.1.KeyPassphrase
        password = wlanConfig.PreSharedKey?.['1']?.KeyPassphrase?._value || null;
        passwordPath = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.${paramPath}`;
      } else {
        // ZTE/FiberHome style: KeyPassphrase
        password = wlanConfig[paramPath]?._value || null;
        passwordPath = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.${paramPath}`;
      }
    } else {
      // Fallback if no WiFi config found
      password = wlanConfig.KeyPassphrase?._value || null;
      passwordPath = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.KeyPassphrase`;
    }

    wifiConfigurations[`wlan${i}`] = {
      enabled: { path: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Enable`, value: enabled },
      ssid: { path: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.SSID`, value: ssidValue },
      password: { path: passwordPath, value: password },
      security: { 
        path: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.BeaconType`, 
        rawValue: rawSecurity,
        normalizedValue: normalizedSecurity 
      },
      stations: { path: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.TotalAssociations`, value: stations },
      channel: { path: `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Channel`, value: channel }
    };
  }

  return wifiConfigurations;
}

// Helper function: Process WiFi Clients
function processWiFiClients(item) {
  const wifiClients = [];
  const hosts = item.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host || {};

  for (const [hostIndex, host] of Object.entries(hosts)) {
    const interfaceType = host.InterfaceType?._value;
    const active = host.Active?._value;

    if (interfaceType === '802.11' && active) {
      wifiClients.push({
        index: hostIndex,
        hostname: host.HostName?._value || '',
        ip: host.IPAddress?._value || '',
        mac: host.MACAddress?._value || ''
      });
    }
  }

  return wifiClients;
}

// Helper function: Format timestamp to WIB
function formatToWIB(utcTimestamp) {
  if (!utcTimestamp) return null;

  try {
    const date = new Date(utcTimestamp);
    // Convert to WIB (UTC+7)
    const wibDate = new Date(date.getTime() + (7 * 60 * 60 * 1000));
    
    const year = wibDate.getUTCFullYear();
    const month = String(wibDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(wibDate.getUTCDate()).padStart(2, '0');
    const hours = String(wibDate.getUTCHours()).padStart(2, '0');
    const minutes = String(wibDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(wibDate.getUTCSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch (error) {
    return 'Invalid date';
  }
}

export { getDetailDevice };

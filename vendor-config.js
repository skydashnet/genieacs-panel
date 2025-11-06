import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'database.sqlite');

/**
 * Vendor Configuration Module - SIMPLIFIED
 * Single table design for easy management
 */

/**
 * Get all vendors from database
 * @returns {Promise<Array>} Array of vendor objects
 */
export async function getVendors() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all('SELECT * FROM vendors WHERE enabled = 1 ORDER BY priority DESC, name ASC', [], (err, rows) => {
      db.close();
      if (err) reject(err);
      else {
        const vendors = rows.map(row => ({
          ...row,
          manufacturer_patterns: JSON.parse(row.manufacturer_patterns || '[]'),
          product_patterns: JSON.parse(row.product_patterns || '[]')
        }));
        resolve(vendors);
      }
    });
  });
}

/**
 * Detect vendor based on manufacturer, product class, and actual device parameters
 * Now returns complete vendor info with all parameter paths!
 * 
 * @param {string} manufacturer - Device manufacturer
 * @param {string} productClass - Device product class
 * @param {Object} deviceData - Full device data from GenieACS (optional, for prefix checking)
 * @returns {Promise<Object|null>} Vendor object with all fields or null if not found
 */
export async function detectVendor(manufacturer, productClass, deviceData = null) {
  const vendors = await getVendors();

  // If device data provided, first try to match by parameter prefix
  if (deviceData) {
    const matchingVendors = [];
    
    for (const vendor of vendors) {
      // Check manufacturer patterns
      if (manufacturer) {
        const manufacturerLower = manufacturer.toLowerCase();
        const matchesManufacturer = vendor.manufacturer_patterns.some(pattern => 
          manufacturerLower.includes(pattern.toLowerCase())
        );
        
        if (matchesManufacturer) {
          // If has product patterns, check them too
          if (vendor.product_patterns.length > 0 && productClass) {
            const productClassLower = productClass.toLowerCase();
            const matchesProduct = vendor.product_patterns.some(pattern =>
              productClassLower.includes(pattern.toLowerCase())
            );
            
            if (matchesProduct) {
              matchingVendors.push(vendor);
            }
          } else if (vendor.product_patterns.length === 0) {
            matchingVendors.push(vendor);
          }
        }
      }
    }
    
    // If multiple vendors match, use parameter_prefix to distinguish
    if (matchingVendors.length > 1) {
      for (const vendor of matchingVendors) {
        if (vendor.parameter_prefix && hasVendorPrefix(deviceData, vendor.parameter_prefix)) {
          return vendor;
        }
      }
    } else if (matchingVendors.length === 1) {
      return matchingVendors[0];
    }
  }

  // Fallback: Original logic without prefix checking
  for (const vendor of vendors) {
    // Check manufacturer patterns first (higher priority)
    if (manufacturer) {
      const manufacturerLower = manufacturer.toLowerCase();
      const matchesManufacturer = vendor.manufacturer_patterns.some(pattern => 
        manufacturerLower.includes(pattern.toLowerCase())
      );
      
      if (matchesManufacturer) {
        // If has product patterns, check them too
        if (vendor.product_patterns.length > 0 && productClass) {
          const productClassLower = productClass.toLowerCase();
          const matchesProduct = vendor.product_patterns.some(pattern =>
            productClassLower.includes(pattern.toLowerCase())
          );
          
          if (matchesProduct) {
            return vendor; // Both match!
          }
        } else {
          // No product patterns specified, manufacturer match is enough
          return vendor;
        }
      }
    }

    // Check product class patterns only
    if (productClass) {
      const productClassLower = productClass.toLowerCase();
      const matchesProduct = vendor.product_patterns.some(pattern =>
        productClassLower.includes(pattern.toLowerCase())
      );

      if (matchesProduct) {
        return vendor;
      }
    }
  }

  return null; // Unknown vendor
}

/**
 * Check if device data contains specific vendor parameter prefix
 * @param {Object} deviceData - Device data from GenieACS
 * @param {string} prefix - Vendor parameter prefix (e.g., 'X_CT-COM', 'X_CMCC', 'X_HW')
 * @returns {boolean} True if prefix found in device structure
 */
function hasVendorPrefix(deviceData, prefix) {
  if (!deviceData || !prefix) return false;
  
  // Check in InternetGatewayDevice structure
  const igdData = deviceData.InternetGatewayDevice;
  if (!igdData) return false;
  
  // Check if prefix exists as a key in IGD
  if (igdData[prefix]) {
    return true;
  }
  
  // Check in WANDevice connections (common location for vendor-specific params)
  const wanDevices = igdData.WANDevice;
  if (wanDevices) {
    for (const wanKey in wanDevices) {
      const wanDevice = wanDevices[wanKey];
      if (wanDevice && wanDevice.WANConnectionDevice) {
        for (const connKey in wanDevice.WANConnectionDevice) {
          const connDevice = wanDevice.WANConnectionDevice[connKey];
          
          // Check in connection device
          if (connDevice && connDevice[prefix]) {
            return true;
          }
          
          // Check in WANIPConnection
          if (connDevice && connDevice.WANIPConnection) {
            for (const ipKey in connDevice.WANIPConnection) {
              const ipConn = connDevice.WANIPConnection[ipKey];
              if (ipConn && ipConn[prefix]) {
                return true;
              }
            }
          }
          
          // Check in WANPPPConnection
          if (connDevice && connDevice.WANPPPConnection) {
            for (const pppKey in connDevice.WANPPPConnection) {
              const pppConn = connDevice.WANPPPConnection[pppKey];
              if (pppConn && pppConn[prefix]) {
                return true;
              }
            }
          }
        }
      }
    }
  }
  
  return false;
}

/**
 * DEPRECATED: detectSubType is no longer needed
 * Vendor detection now returns complete vendor info in single call
 * 
 * @deprecated Use detectVendor() instead which returns all vendor info
 */
export async function detectSubType(vendorId, productClass, oui = null) {
  console.warn('detectSubType() is deprecated. Use detectVendor() instead.');
  return null;
}

/**
 * DEPRECATED: getVendorParameters is no longer needed
 * Parameter paths are now directly in vendor object
 * 
 * @deprecated Parameter paths are now in vendor object (vendor.service_list_path, etc)
 */
export async function getVendorParameters(vendorId, subTypeId, category) {
  console.warn('getVendorParameters() is deprecated. Use vendor object properties instead.');
  return [];
}

/**
 * Get specific vendor parameter by name
 * @param {number} vendorId - Vendor ID
 * @param {number|null} subTypeId - Sub-type ID (optional)
 * @param {string} category - Parameter category
 * @param {string} paramName - Parameter name
 * @returns {Promise<Object|null>} Parameter object or null
 */
export async function getVendorParameter(vendorId, subTypeId, category, paramName) {
  const params = await getVendorParameters(vendorId, subTypeId, category);
  return params.find(p => p.param_name === paramName) || null;
}

/**
 * Normalize WiFi security value based on vendor
 * @param {number} vendorId - Vendor ID
 * @param {string} rawSecurityValue - Raw security value from device
 * @returns {Promise<string>} Normalized security value
 */
export async function normalizeWiFiSecurity(vendorId, rawSecurityValue) {
  if (!rawSecurityValue) return 'Unknown';

  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.get(
      'SELECT normalized_security FROM wifi_security_mappings WHERE vendor_id = ? AND raw_security_value = ?',
      [vendorId, rawSecurityValue],
      (err, row) => {
        db.close();
        if (err) {
          reject(err);
        } else if (row) {
          resolve(row.normalized_security);
        } else {
          // If no mapping found, return raw value
          resolve(rawSecurityValue);
        }
      }
    );
  });
}

/**
 * Get all sub-types for a vendor
 * @param {number} vendorId - Vendor ID
 * @returns {Promise<Array>} Array of sub-type objects
 */
export async function getSubTypes(vendorId) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all(
      'SELECT * FROM vendor_sub_types WHERE vendor_id = ? ORDER BY priority DESC, sub_type_name ASC',
      [vendorId],
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else {
          const subTypes = rows.map(row => ({
            ...row,
            detection_patterns: JSON.parse(row.detection_patterns || '{}')
          }));
          resolve(subTypes);
        }
      }
    );
  });
}

/**
 * Get all WiFi security mappings for a vendor
 * @param {number} vendorId - Vendor ID
 * @returns {Promise<Array>} Array of security mapping objects
 */
export async function getWiFiSecurityMappings(vendorId) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all(
      'SELECT * FROM wifi_security_mappings WHERE vendor_id = ? ORDER BY raw_security_value ASC',
      [vendorId],
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

/**
 * Extract parameter value from connection object using vendor config
 * 
 * ⚠️ DEPRECATED: This function is from the old 3-table structure
 * New simplified structure uses vendor object properties directly
 * (vendor.service_list_path, vendor.vlan_id_path, etc.)
 * 
 * @deprecated Use helper functions in getdetaildevice.js instead (createServiceList, createVlanInfo, etc.)
 * @param {Object} connection - Connection object from GenieACS
 * @param {Object} connDevice - Connection device object (for VLAN at device level)
 * @param {number} vendorId - Vendor ID
 * @param {number|null} subTypeId - Sub-type ID
 * @param {string} category - Parameter category
 * @param {string} paramName - Parameter name
 * @param {Object} indices - WAN device indices (wanDeviceIndex, connDeviceIndex)
 * @returns {Promise<Object|null>} Parameter value object with path and value
 */
export async function extractParameter(connection, connDevice, vendorId, subTypeId, category, paramName, indices = {}) {
  console.warn('extractParameter() is deprecated. Use helper functions in getdetaildevice.js instead.');
  
  const params = await getVendorParameters(vendorId, subTypeId, category);
  
  // Get all parameters matching the name, sorted by priority
  const matchingParams = params.filter(p => p.param_name === paramName);
  
  for (const param of matchingParams) {
    const path = param.parameter_path;
    let value = null;
    let fullPath = '';

    // Strategy: Try connection level first, then device level (dynamic detection)
    // This works for EPON, GPON, and all vendor variants
    if (path.startsWith('InternetGatewayDevice.')) {
      // Absolute path (e.g., for security parameters)
      fullPath = path;
      // This will need to be extracted from full device object, not connection
      // For now, mark it as needing special handling
      continue;
    }
    
    // Try connection-level parameter first
    const pathParts = path.split('.');
    let current = connection;
    
    for (const part of pathParts) {
      if (current && typeof current === 'object') {
        current = current[part];
      } else {
        current = null;
        break;
      }
    }

    if (current && current._value !== undefined) {
      value = current._value;
      if (value !== null && value !== '' && value !== 0) {
        fullPath = path;
        return { path: fullPath, value, priority: param.priority };
      }
    }
    
    // If not found at connection level, try device level
    // This handles WANEponLinkConfig, WANGponLinkConfig, and other device-level params
    if (!value) {
      const pathParts = path.split('.');
      let current = connDevice;
      
      for (const part of pathParts) {
        if (current && typeof current === 'object') {
          current = current[part];
        } else {
          current = null;
          break;
        }
      }

      if (current && current._value !== undefined) {
        value = current._value;
        if (value !== null && value !== '' && value !== 0) {
          fullPath = `InternetGatewayDevice.WANDevice.${indices.wanDeviceIndex}.WANConnectionDevice.${indices.connDeviceIndex}.${path}`;
          return { path: fullPath, value, priority: param.priority };
        }
      }
    }
  }

  return null; // No value found in any parameter path
}

export default {
  getVendors,
  detectVendor,
  detectSubType,
  getVendorParameters,
  getVendorParameter,
  normalizeWiFiSecurity,
  getSubTypes,
  getWiFiSecurityMappings,
  extractParameter
};

import Setting from '../models/Setting.js';
import VendorService from './vendorService.js';
import Vendor from '../models/Vendor.js';

class DeviceService {
  static async getGenieAcsUrl() {
    const settings = await Setting.getAll();
    return settings.genieAcsUrl;
  }

  static async getVirtualParameters() {
    const settings = await Setting.getAll();
    
    return {
      vpPppoeUsername: settings.vpPppoeUsername || 'VirtualParameters.pppoeUsername',
      vpWanBridge: settings.vpWanBridge || 'VirtualParameters.WANBRIDGE',
      vpRxPower: settings.vpRxPower || 'VirtualParameters.RXPower',
      vpTemperature: settings.vpTemperature || 'VirtualParameters.gettemp',
      vpActiveDevices: settings.vpActiveDevices || 'VirtualParameters.activedevices',
      vpSuperAdmin: settings.vpSuperAdmin || 'VirtualParameters.superAdmin',
      vpSuperPassword: settings.vpSuperPassword || 'VirtualParameters.superPassword',
      vpUserAdmin: settings.vpUserAdmin || 'VirtualParameters.userAdmin',
      vpUserPassword: settings.vpUserPassword || 'VirtualParameters.userPassword'
    };
  }

  static async fetchFromGenieAcs(endpoint, query = {}) {
    try {
      const baseUrl = await this.getGenieAcsUrl();
      
      if (!baseUrl) {
        throw new Error('GenieACS URL not configured');
      }
      let url = new URL(baseUrl);
      if (!url.pathname.startsWith('/devices')) {
        url.pathname = '/devices';
      }
      url = new URL(endpoint, url);
      
      Object.keys(query).forEach(key => {
        if (query[key] !== undefined && query[key] !== null) {
          url.searchParams.append(key, query[key]);
        }
      });
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
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
  }

  static async getDevices() {
    try {
      const virtualParams = await this.getVirtualParameters();
      
      const projection = [
        '_id',
        '_deviceId._ProductClass',
        '_deviceId._SerialNumber',
        virtualParams.vpPppoeUsername,
        virtualParams.vpWanBridge,
        virtualParams.vpRxPower,
        virtualParams.vpTemperature,
        virtualParams.vpActiveDevices,
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.SSID',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.SSID',
        '_lastInform'
      ];

      const apiUrl = `?projection=${encodeURIComponent(projection.join(','))}`;
      const data = await this.fetchFromGenieAcs(apiUrl);

      if (!Array.isArray(data)) {
        throw new Error('Invalid API response');
      }

      return data.map(item => this.processDeviceData(item, virtualParams));
    } catch (error) {
      console.error('Error getting devices:', error);
      throw error;
    }
  }

  static processDeviceData(item, virtualParams) {
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
      
      return current?._value || null;
    };

    const pppsecret = getNestedValue(item, virtualParams.vpPppoeUsername);
    const wanbridge = getNestedValue(item, virtualParams.vpWanBridge);
    const rxpower = getNestedValue(item, virtualParams.vpRxPower);
    const gettemp = getNestedValue(item, virtualParams.vpTemperature);
    const activedevices = getNestedValue(item, virtualParams.vpActiveDevices);

    const deviceId = item._id || null;
    const serialNumber = item._deviceId?._SerialNumber || null;
    const typeont = item._deviceId?._ProductClass || null;

    const wlan = item.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
    const ssid1 = wlan['1']?.SSID?._value || null;
    const ssid2 = wlan['2']?.SSID?._value || null;
    const ssid3 = wlan['3']?.SSID?._value || null;
    const ssid4 = wlan['4']?.SSID?._value || null;
    const ssid5 = wlan['5']?.SSID?._value || null;
    const ssid6 = wlan['6']?.SSID?._value || null;
    const ssid7 = wlan['7']?.SSID?._value || null;
    const ssid8 = wlan['8']?.SSID?._value || null;

    let lastInformWIB = null;
    if (item._lastInform) {
      try {
        const date = new Date(item._lastInform);
        const wibOffset = 7 * 60;
        const wibDate = new Date(date.getTime() + wibOffset * 60 * 1000);
        
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
  }

  static async getDetailDevice(deviceId) {
    if (!deviceId) {
      throw new Error('Device ID is required');
    }

    try {
      const baseUrl = await this.getGenieAcsUrl();
      
      if (!baseUrl) {
        throw new Error('GenieACS URL not configured in settings');
      }

      const virtualParams = await this.getVirtualParameters();
      const vendorConfigurations = await Vendor.getAll();

      const projection = [
        '_id',
        '_deviceId._ProductClass',
        '_deviceId._SerialNumber',
        '_deviceId._Manufacturer',
        '_deviceId._OUI',
        virtualParams.vpPppoeUsername,
        virtualParams.vpWanBridge,
        virtualParams.vpRxPower,
        virtualParams.vpTemperature,
        virtualParams.vpActiveDevices,
        virtualParams.vpSuperAdmin,
        virtualParams.vpSuperPassword,
        virtualParams.vpUserAdmin,
        virtualParams.vpUserPassword,
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
        'InternetGatewayDevice.DeviceInfo.HardwareVersion',
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
        'InternetGatewayDevice.DeviceInfo.UpTime',
        'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress',
        'InternetGatewayDevice.WANDevice.1.WANEthernetInterfaceConfig.MACAddress',
        'InternetGatewayDevice.WANDevice',
        '_lastInform',
        '_lastBoot',
        '_registered',
        'InternetGatewayDevice.LANDevice.1.Hosts.Host'
      ];

      vendorConfigurations.forEach(vendor => {
        if (vendor.http_wan_enable_path) {
          projection.push(vendor.http_wan_enable_path);
        }
        if (vendor.firewall_level_path) {
          projection.push(vendor.firewall_level_path);
        }
      });

      const query = JSON.stringify({ _id: deviceId });
      const apiUrl = `${baseUrl}?query=${encodeURIComponent(query)}&projection=${encodeURIComponent(projection.join(','))}`;

      const response = await fetch(apiUrl, {
        timeout: 15000,
        headers: {
          'Accept-Encoding': 'gzip'
        }
      });

      const data = await response.json();

      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Device not found');
      }

      return await this.processDetailDeviceData(data[0], virtualParams, vendorConfigurations);
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

  static async processDetailDeviceData(item, virtualParams, vendorConfigurations) {
    const getVPValue = (vpPath) => {
      if (!vpPath || !item.VirtualParameters) return null;
      const paramName = vpPath.split('.').pop();
      return item.VirtualParameters[paramName]?._value || null;
    };
    
    const getValue = (path) => {
      if (!path || !item) return null;
      const parts = path.split('.');
      let current = item;
      for (const part of parts) {
        if (current && typeof current === 'object') {
          current = current[part];
        } else {
          return null;
        }
      }
      return current?._value || null;
    };

    const getRelativeValue = (obj, path) => {
      if (!path || !obj) return null;
      const parts = path.split('.');
      let current = obj;
      for (const part of parts) {
        if (current && typeof current === 'object') {
          current = current[part];
        } else {
          return null;
        }
      }
      return (current && current._value !== undefined) ? current._value : current;
    };

    const manufacturer = item._deviceId?._Manufacturer || null;
    const productClass = item._deviceId?._ProductClass || null;
    
    const vendorObj = await VendorService.detectVendor(manufacturer, productClass, item);
    const vendor = vendorObj ? vendorObj.name.toLowerCase() : 'unknown';
    const vendorId = vendorObj ? vendorObj.id : null;

    const deviceInfo = {
      productclass: productClass,
      serialNumber: item._deviceId?._SerialNumber || null,
      manufacturer: manufacturer,
      oui: item._deviceId?._OUI || null,
      hardwareVersion: getValue('InternetGatewayDevice.DeviceInfo.HardwareVersion'),
      softwareVersion: getValue('InternetGatewayDevice.DeviceInfo.SoftwareVersion'),
      upTime: getValue('InternetGatewayDevice.DeviceInfo.UpTime'),
      macAddress: 
        getValue('InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress') ||
        getValue('InternetGatewayDevice.WANDevice.1.WANEthernetInterfaceConfig.MACAddress') ||
        null
    };

    const virtualParameters = {
      pppoeUsername: {
        path: virtualParams.vpPppoeUsername,
        value: getVPValue(virtualParams.vpPppoeUsername)
      },
      wanBridge: {
        path: virtualParams.vpWanBridge,
        value: getVPValue(virtualParams.vpWanBridge)
      },
      rxpower: {
        path: virtualParams.vpRxPower,
        value: getVPValue(virtualParams.vpRxPower)
      },
      temperature: {
        path: virtualParams.vpTemperature,
        value: getVPValue(virtualParams.vpTemperature)
      },
      activedevices: {
        path: virtualParams.vpActiveDevices,
        value: getVPValue(virtualParams.vpActiveDevices)
      },
      superAdmin: {
        path: virtualParams.vpSuperAdmin,
        value: getVPValue(virtualParams.vpSuperAdmin)
      },
      superPassword: {
        path: virtualParams.vpSuperPassword,
        value: getVPValue(virtualParams.vpSuperPassword)
      },
      userAdmin: {
        path: virtualParams.vpUserAdmin,
        value: getVPValue(virtualParams.vpUserAdmin)
      },
      userPassword: {
        path: virtualParams.vpUserPassword,
        value: getVPValue(virtualParams.vpUserPassword)
      }
    };

    const wifi = [];
    const wlanConfig = item.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration;

    if (wlanConfig) {
      for (let i = 1; i <= 8; i++) {
        const ssidData = wlanConfig[i];
        if (ssidData && ssidData.SSID?._value) {
          wifi.push({
            index: i,
            enable: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Enable`),
            ssid: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.SSID`),
            password: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.KeyPassphrase`) || getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.PreSharedKey.1.KeyPassphrase`),
            security: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.BeaconType`),
            channel: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Channel`),
            totalAssociations: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.TotalAssociations`)
          });
        }
      }
    }
    
    const wan = [];
    const wanDevice = item.InternetGatewayDevice?.WANDevice;

    if (wanDevice) {
      for (const devKey in wanDevice) {
        if (devKey.startsWith('_')) continue;
        if (!wanDevice[devKey] || !wanDevice[devKey].WANConnectionDevice) continue;
        
        for (const connKey in wanDevice[devKey].WANConnectionDevice) {
          if (connKey.startsWith('_')) continue;
          const connDev = wanDevice[devKey].WANConnectionDevice[connKey];
          if (!connDev) continue;

          let connection = null;
          let connType = null;
          let connPath = null;

          if (connDev.WANIPConnection) {
            for (const ipKey in connDev.WANIPConnection) {
              if (ipKey.startsWith('_')) continue;
              if (connDev.WANIPConnection[ipKey]) {
                connection = connDev.WANIPConnection[ipKey];
                connType = 'IP';
                connPath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANIPConnection.${ipKey}`;
                break;
              }
            }
          }
          
          if (!connection && connDev.WANPPPConnection) {
             for (const pppKey in connDev.WANPPPConnection) {
              if (pppKey.startsWith('_')) continue;
              if (connDev.WANPPPConnection[pppKey]) {
                connection = connDev.WANPPPConnection[pppKey];
                connType = 'PPPoE';
                connPath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANPPPConnection.${pppKey}`;
                break;
              }
            }
          }

          if (connection && connPath) {
            
            let vlanId = null;
            const vlanPath = vendorObj?.vlan_id_path;
            if (vlanPath) {
              if (vlanPath.startsWith('VirtualParameters.')) {
                vlanId = getVPValue(vlanPath);
              } else {
                vlanId = getRelativeValue(connection, vlanPath);
              }
            }
            
            let serviceList = null;
            const servicePath = vendorObj?.service_list_path;
            if (servicePath) {
              if (servicePath.startsWith('VirtualParameters.')) {
                 serviceList = getVPValue(servicePath);
              } else {
                serviceList = getRelativeValue(connection, servicePath);
              }
            }
            
            let bindings = null;
            const bindingPath = vendorObj?.lan_binding_path;
            if (bindingPath) {
              const bindingObj = getRelativeValue(connection, bindingPath);
              if (bindingObj && typeof bindingObj === 'object') {
                bindings = { lan: [], ssid: [] };
                for (let i = 1; i <= 4; i++) {
                  if (getRelativeValue(bindingObj, `Lan${i}Enable`)) {
                    bindings.lan.push(`LAN${i}`);
                  }
                }
                for (let i = 1; i <= 8; i++) {
                  if (getRelativeValue(bindingObj, `SSID${i}Enable`)) {
                    bindings.ssid.push(`SSID${i}`);
                  }
                }
              }
            }

            wan.push({
              index: `${devKey}.${connKey}`,
              connType: connType,
              name: getRelativeValue(connection, 'Name'),
              status: getValue(`${connPath}.ConnectionStatus`),
              ipAddress: getValue(`${connPath}.ExternalIPAddress`),
              macAddress: getValue(`InternetGatewayDevice.WANDevice.${devKey}.WANEthernetInterfaceConfig.MACAddress`),
              vlanId: vlanId,
              username: getRelativeValue(connection, 'Username'),
              serviceList: serviceList,
              connectionType: getRelativeValue(connection, 'ConnectionType'),
              natEnabled: getRelativeValue(connection, 'NATEnabled'),
              bindings: bindings
            });
          }
        }
      }
    }

    return {
      _id: item._id,
      _lastInform: item._lastInform,
      _lastBoot: item._lastBoot,
      _registered: item._registered,
      vendor: vendor,
      deviceInfo,
      virtualParameters,
      wifi, 
      wan,
      vendorDetection: {
        vendor: vendor,
        vendorId: vendorId,
        vendorName: vendorObj?.name || 'Unknown',
        parameterPrefix: vendorObj?.parameter_prefix || null
      },
      _raw: item 
    };
  }

  static async deleteDevice(deviceId) {
    try {
      const baseUrl = await this.getGenieAcsUrl();
      
      if (!baseUrl) {
        throw new Error('GenieACS URL not configured');
      }
      
      const url = `${baseUrl}/${encodeURIComponent(deviceId)}`;
      
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GenieACS delete API error: ${response.status} - ${errorText}`);
      }
      
      return true;
    } catch (error) {
      console.error('Error deleting device:', error);
      throw error;
    }
  }

  static async rebootDevice(deviceId) {
    try {
      const baseUrl = await this.getGenieAcsUrl();
      
      if (!baseUrl) {
        throw new Error('GenieACS URL not configured');
      }
      
      const taskPayload = {
        name: 'reboot'
      };

      const taskUrl = `${baseUrl}/${encodeURIComponent(deviceId)}/tasks?timeout=3000&connection_request`;

      const response = await fetch(taskUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(taskPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GenieACS reboot API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json().catch(() => null);
      return result;
    } catch (error) {
      console.error('Error rebooting device:', error);
      throw error;
    }
  }
  
  static async updateWanConfig(deviceId, wanIndex, formData) {
    const rawDeviceData = await this.fetchFromGenieAcs(deviceId, {});
    const item = rawDeviceData[0];
    const manufacturer = item._deviceId?._Manufacturer || null;
    const productClass = item._deviceId?._ProductClass || null;
    const vendorObj = await VendorService.detectVendor(manufacturer, productClass, item);
    
    if (!vendorObj) {
      throw new Error('Vendor not found, cannot determine parameter paths.');
    }
    
    const [devKey, connKey] = wanIndex.split('.');
    const connDev = item.InternetGatewayDevice?.WANDevice?.[devKey]?.WANConnectionDevice?.[connKey];
    
    if (!connDev) throw new Error('WAN Connection path not found in raw data.');

    let connection = null;
    let connType = null;
    let basePath = null;
    
    if (connDev.WANPPPConnection) {
        for (const pppKey in connDev.WANPPPConnection) {
        if (pppKey.startsWith('_')) continue;
        connection = connDev.WANPPPConnection[pppKey];
        connType = 'PPPoE';
        basePath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANPPPConnection.${pppKey}`;
        break;
      }
    }

    if (!basePath) {
      throw new Error('Only PPPoE connections are editable for now.');
    }
    const tasks = [];
    const { vlanEnabled, vlanId, username, password, bindings } = formData;
    const vlanPath = vendorObj?.vlan_id_path;
    if (vlanPath) {
      tasks.push({
        name: 'setParameterValues',
        parameterValues: [
          [`${basePath}.${vlanPath}`, vlanEnabled ? (vlanId || 0) : 0, 'xsd:unsignedInt'],
        ]
      });
    }

    if (username !== undefined) {
      tasks.push({
        name: 'setParameterValues',
        parameterValues: [
          [`${basePath}.Username`, username, 'xsd:string']
        ]
      });
    }
    if (password) { 
        tasks.push({
        name: 'setParameterValues',
        parameterValues: [
          [`${basePath}.Password`, password, 'xsd:string']
        ]
      });
    }
    
    const bindingPath = vendorObj?.lan_binding_path;
    if (bindingPath) {
      const fullBindingPath = `${basePath}.${bindingPath}`;
      const bindingParams = [];
      for (let i = 1; i <= 4; i++) {
        bindingParams.push([`${fullBindingPath}.Lan${i}Enable`, bindings[`LAN${i}`] ? 1 : 0, 'xsd:unsignedInt']);
      }
      for (let i = 1; i <= 8; i++) {
        bindingParams.push([`${fullBindingPath}.SSID${i}Enable`, bindings[`SSID${i}`] ? 1 : 0, 'xsd:unsignedInt']);
      }
      
      if (bindingParams.length > 0) {
        tasks.push({
          name: 'setParameterValues',
          parameterValues: bindingParams
        });
      }
    }
    const genieAcsUrl = await this.getGenieAcsUrl();
    const tasksUrl = `${genieAcsUrl}/${deviceId}/tasks?connection_request=1`;
    
    for (const task of tasks) {
      const res = await fetch(tasksUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task)
      });
      if (!res.ok) {
        const error = await res.json();
        console.error('GenieACS Task Failed:', error);
        throw new Error(`GenieACS task ${task.name} failed`);
      }
    }
    
    return { success: true, message: 'WAN configuration updated. Device will refresh on next inform.' };
  }

  static async updateCredentials(deviceId, type, password) {
    const settings = await Setting.getAllAsObject();
    let userPath, passPath;

    if (type === 'super') {
      userPath = settings.vpSuperAdmin;
      passPath = settings.vpSuperPassword;
    } else if (type === 'user') {
      userPath = settings.vpUserAdmin;
      passPath = settings.vpUserPassword;
    } else {
      throw new Error('Invalid credential type specified.');
    }

    if (!passPath) {
      throw new Error(`VirtualParameter path for ${type} password is not set in settings.`);
    }
    const task = {
      name: 'setParameterValues',
      parameterValues: [
        [passPath, password, 'xsd:string']
      ]
    };
    const genieAcsUrl = await this.getGenieAcsUrl();
    const tasksUrl = `${genieAcsUrl}/${deviceId}/tasks?connection_request=1`;

    const res = await fetch(tasksUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task)
    });

    if (!res.ok) {
      const error = await res.json();
      console.error('GenieACS Task Failed:', error);
      throw new Error(`GenieACS task setParameterValues failed`);
    }

    return { success: true, message: `${type} admin password update task queued.` };
  }
}

export default DeviceService;
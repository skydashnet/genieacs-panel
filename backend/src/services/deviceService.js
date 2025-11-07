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
      url = new URL(url.origin + (url.pathname.replace(/\/devices\/?$/, '')));
      
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

      return this.processDetailDeviceData(data[0], virtualParams, vendorConfigurations);
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

  static processDetailDeviceData(item, virtualParams, vendorConfigurations) {
    const getVPValue = (vpPath) => {
      if (!vpPath || !item.VirtualParameters) return null;
      const paramName = vpPath.split('.').pop();
      return item.VirtualParameters[paramName]?._value || null;
    };

    const manufacturer = item._deviceId?._Manufacturer || null;
    const productClass = item._deviceId?._ProductClass || null;
    
    const vendorObj = VendorService.detectVendor(manufacturer, productClass, item);
    const vendor = vendorObj ? vendorObj.name.toLowerCase() : 'unknown';
    const vendorId = vendorObj ? vendorObj.id : null;

    const deviceInfo = {
      productclass: productClass,
      serialNumber: item._deviceId?._SerialNumber || null,
      manufacturer: manufacturer,
      oui: item._deviceId?._OUI || null,
      hardwareVersion: item.InternetGatewayDevice?.DeviceInfo?.HardwareVersion?._value || null,
      softwareVersion: item.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion?._value || null,
      upTime: item.InternetGatewayDevice?.DeviceInfo?.UpTime?._value || null,
      macAddress: 
        item.InternetGatewayDevice?.LANDevice?.['1']?.LANEthernetInterfaceConfig?.['1']?.MACAddress?._value ||
        item.InternetGatewayDevice?.WANDevice?.['1']?.WANEthernetInterfaceConfig?.MACAddress?._value ||
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

    return {
      _id: item._id,
      vendor: vendor,
      deviceInfo,
      virtualParameters,
      vendorDetection: {
        vendor: vendor,
        vendorId: vendorId,
        vendorName: vendorObj?.name || 'Unknown',
        parameterPrefix: vendorObj?.parameter_prefix || null
      }
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
}

export default DeviceService;
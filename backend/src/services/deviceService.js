import Setting from '../models/Setting.js';
import VendorService from './vendorService.js';
import Vendor from '../models/Vendor.js';
import { DEFAULT_SETTINGS } from '../config/seed.js';

class DeviceService {
  static getParameterNode(obj, parameterPath) {
    if (!obj || !parameterPath) return null;
    let current = obj;
    for (const part of String(parameterPath).split('.')) {
      if (!current || typeof current !== 'object') return null;
      current = current[part];
    }
    return current ?? null;
  }

  static getParameterValue(obj, parameterPath) {
    const current = this.getParameterNode(obj, parameterPath);
    if (current && typeof current === 'object' && '_value' in current) {
      return current._value ?? null;
    }
    return current ?? null;
  }

  static isEnabledValue(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  static resolveParameterPath(basePath, configuredPath) {
    if (!configuredPath) return null;
    if (
      configuredPath.startsWith('InternetGatewayDevice.') ||
      configuredPath.startsWith('Device.') ||
      configuredPath.startsWith('VirtualParameters.')
    ) {
      return configuredPath;
    }
    return `${basePath}.${configuredPath.replace(/^\.+/, '')}`;
  }

  static async getGenieAcsUrl() {
    const settings = await Setting.getAll();
    return settings.genieAcsUrl;
  }

  static async getVirtualParameters() {
    const settings = await Setting.getAll();

    return Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS)
        .filter((key) => key.startsWith('vp'))
        .map((key) => [key, settings[key] ?? DEFAULT_SETTINGS[key]])
    );
  }

  static async getDevicesBaseUrl() {
    const baseUrl = await this.getGenieAcsUrl();
    if (!baseUrl) {
      throw new Error('GenieACS URL not configured');
    }
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('GenieACS URL must use HTTP or HTTPS');
    }
    if (url.username || url.password) {
      throw new Error('Credentials in the GenieACS URL are not supported');
    }
    url.pathname = '/devices';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  }

  static async buildGenieAcsUrl(endpoint = '', query = {}) {
    const base = await this.getDevicesBaseUrl();

    let urlStr;
    if (/^https?:\/\//i.test(endpoint)) {
      urlStr = endpoint;
    } else if (!endpoint) {
      urlStr = base;
    } else if (endpoint.startsWith('?')) {
      urlStr = `${base}${endpoint}`;
    } else {
      urlStr = `${base}/${endpoint.replace(/^\/+/, '')}`;
    }

    const url = new URL(urlStr);
    Object.keys(query || {}).forEach(key => {
      if (query[key] !== undefined && query[key] !== null) {
        url.searchParams.append(key, query[key]);
      }
    });
    return url;
  }

  static async fetchFromGenieAcs(endpoint, query = {}, method = 'GET', body = null) {
    try {
      const url = await this.buildGenieAcsUrl(endpoint, query);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const options = {
          method,
          headers: { 'Accept': 'application/json' },
          signal: controller.signal
        };
        if (body !== null && body !== undefined) {
          options.headers['Content-Type'] = 'application/json';
          options.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        const response = await fetch(url, options);

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`GenieACS API responded with status: ${response.status}${errorText ? ` - ${errorText}` : ''}`);
        }

        const text = await response.text();
        return text ? JSON.parse(text) : null;
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
        '_deviceId._Manufacturer',
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
        '_lastInform',
        '_registered'
      ].filter(Boolean);

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
    const pppsecret = this.getParameterValue(item, virtualParams.vpPppoeUsername);
    const wanbridge = this.getParameterValue(item, virtualParams.vpWanBridge);
    const rxpower = this.getParameterValue(item, virtualParams.vpRxPower);
    const gettemp = this.getParameterValue(item, virtualParams.vpTemperature);
    const activedevices = this.getParameterValue(item, virtualParams.vpActiveDevices);

    const deviceId = item._id || null;
    const serialNumber = item._deviceId?._SerialNumber || null;
    const typeont = item._deviceId?._ProductClass || null;
    const manufacturer = item._deviceId?._Manufacturer || null;

    const wlan = item.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
    const ssid1 = wlan['1']?.SSID?._value ?? null;
    const ssid2 = wlan['2']?.SSID?._value ?? null;
    const ssid3 = wlan['3']?.SSID?._value ?? null;
    const ssid4 = wlan['4']?.SSID?._value ?? null;
    const ssid5 = wlan['5']?.SSID?._value ?? null;
    const ssid6 = wlan['6']?.SSID?._value ?? null;
    const ssid7 = wlan['7']?.SSID?._value ?? null;
    const ssid8 = wlan['8']?.SSID?._value ?? null;

    return {
      _id: deviceId,
      SerialNumber: serialNumber,
      productclass: typeont,
      manufacturer,
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
      _lastInform: item._lastInform || null,
      _registered: item._registered || null
    };
  }

  static async getDetailDevice(deviceId) {
    if (!deviceId) {
      throw new Error('Device ID is required');
    }

    const virtualParams = await this.getVirtualParameters();
    const vendorConfigurations = await Vendor.getEnabled();

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
      '_registered'
    ];

    vendorConfigurations.forEach(vendor => {
      if (vendor.http_wan_enable_path) {
        projection.push(vendor.http_wan_enable_path);
      }
      if (vendor.firewall_level_path) {
        projection.push(vendor.firewall_level_path);
      }
    });

    const data = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId }),
      projection: projection.filter(Boolean).join(',')
    });

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Device not found');
    }

    return await this.processDetailDeviceData(data[0], virtualParams);
  }

  static async processDetailDeviceData(item, virtualParams) {
    const getValue = (path) => {
      return this.getParameterValue(item, path);
    };

    const getVPValue = getValue;

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
      return (current && current._value !== undefined) ? (current._value ?? null) : (current ?? null);
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

          const connections = [];
          for (const [collection, connType, indexType] of [
            ['WANIPConnection', 'IP', 'ip'],
            ['WANPPPConnection', 'PPPoE', 'ppp']
          ]) {
            const connectionCollection = connDev[collection];
            if (!connectionCollection) continue;
            for (const instanceKey in connectionCollection) {
              if (instanceKey.startsWith('_') || !connectionCollection[instanceKey]) continue;
              connections.push({
                connection: connectionCollection[instanceKey],
                connType,
                index: `${devKey}.${connKey}.${indexType}.${instanceKey}`,
                connPath: `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.${collection}.${instanceKey}`
              });
            }
          }

          for (const { connection, connType, connPath, index } of connections) {
            
            let vlanId = null;
            const vlanPath = vendorObj?.vlan_id_path;
            if (vlanPath) {
              vlanId = this.resolveParameterPath(connPath, vlanPath) === vlanPath
                ? getValue(vlanPath)
                : getRelativeValue(connection, vlanPath);
            }
            
            let serviceList = null;
            const servicePath = vendorObj?.service_list_path;
            if (servicePath) {
              serviceList = this.resolveParameterPath(connPath, servicePath) === servicePath
                ? getValue(servicePath)
                : getRelativeValue(connection, servicePath);
            }
            
            let bindings = null;
            const bindingPath = vendorObj?.lan_binding_path;
            if (bindingPath) {
              const bindingObj = this.resolveParameterPath(connPath, bindingPath) === bindingPath
                ? this.getParameterNode(item, bindingPath)
                : getRelativeValue(connection, bindingPath);
              if (bindingObj && typeof bindingObj === 'object') {
                bindings = { lan: [], ssid: [] };
                for (let i = 1; i <= 4; i++) {
                  if (this.isEnabledValue(getRelativeValue(bindingObj, `Lan${i}Enable`))) {
                    bindings.lan.push(`LAN${i}`);
                  }
                }
                for (let i = 1; i <= 8; i++) {
                  if (this.isEnabledValue(getRelativeValue(bindingObj, `SSID${i}Enable`))) {
                    bindings.ssid.push(`SSID${i}`);
                  }
                }
              }
            }

            wan.push({
              index,
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
              bindings,
              editable: connType === 'PPPoE',
              vlanConfigurable: Boolean(vendorObj?.vlan_id_path),
              bindingsConfigurable: Boolean(vendorObj?.lan_binding_path)
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
      }
    };
  }

  static async postTask(deviceId, task) {
    const endpoint = `${encodeURIComponent(deviceId)}/tasks`;
    return this.fetchFromGenieAcs(endpoint, { connection_request: 1 }, 'POST', task);
  }

  static async deleteDevice(deviceId) {
    const base = await this.getDevicesBaseUrl();
    const url = `${base}/${encodeURIComponent(deviceId)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`GenieACS delete API error: ${response.status} - ${errorText}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }

    return true;
  }

  static async rebootDevice(deviceId) {
    return this.postTask(deviceId, { name: 'reboot' });
  }

  static async summonDevice(deviceId, parameters = []) {
    if (!Array.isArray(parameters) || parameters.length > 100) {
      throw new Error('Parameters must be an array with at most 100 entries');
    }
    if (parameters.some((parameter) => typeof parameter !== 'string' || parameter.length > 512)) {
      throw new Error('Every parameter path must be a string of at most 512 characters');
    }

    const data = await this.postTask(deviceId, {
      name: 'getParameterValues',
      parameterNames: [
        'InternetGatewayDevice.DeviceInfo.SerialNumber',
        ...parameters
      ]
    });

    if (data && data.fault && data.fault.faultString) {
      throw new Error(data.fault.faultString);
    }

    return data;
  }

  static async updateWanConfig(deviceId, wanIndex, formData) {
    const rawDeviceData = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId })
    });
    if (!Array.isArray(rawDeviceData) || rawDeviceData.length === 0) {
      throw new Error('Device not found');
    }
    const item = rawDeviceData[0];
    const manufacturer = item._deviceId?._Manufacturer || null;
    const productClass = item._deviceId?._ProductClass || null;
    const vendorObj = await VendorService.detectVendor(manufacturer, productClass, item);
    
    if (!vendorObj) {
      throw new Error('Vendor not found, cannot determine parameter paths.');
    }
    
    if (!/^\d+\.\d+(?:\.ppp\.\d+)?$/.test(String(wanIndex))) {
      throw new Error('Invalid WAN connection index.');
    }
    const [devKey, connKey, indexType, instanceKey] = wanIndex.split('.');
    const connDev = item.InternetGatewayDevice?.WANDevice?.[devKey]?.WANConnectionDevice?.[connKey];
    
    if (!connDev) throw new Error('WAN Connection path not found in raw data.');

    let basePath = null;

    if (indexType === 'ppp' && connDev.WANPPPConnection?.[instanceKey]) {
      basePath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANPPPConnection.${instanceKey}`;
    } else if (!indexType && connDev.WANPPPConnection) {
      for (const pppKey in connDev.WANPPPConnection) {
        if (pppKey.startsWith('_')) continue;
        basePath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANPPPConnection.${pppKey}`;
        break;
      }
    }

    if (!basePath) {
      throw new Error('Only PPPoE connections are editable for now.');
    }
    const parameterValues = [];
    const {
      vlanEnabled,
      vlanId,
      username,
      password,
      bindings = {}
    } = formData;
    const vlanPath = vendorObj?.vlan_id_path;
    if (vlanPath) {
      const parsedVlanId = Number(vlanId);
      if (vlanEnabled && (!Number.isInteger(parsedVlanId) || parsedVlanId < 1 || parsedVlanId > 4094)) {
        throw new Error('VLAN ID must be an integer between 1 and 4094.');
      }
      parameterValues.push([
        this.resolveParameterPath(basePath, vlanPath),
        vlanEnabled ? parsedVlanId : 0,
        'xsd:unsignedInt'
      ]);
    }

    if (username !== undefined) {
      if (typeof username !== 'string' || username.length > 256) {
        throw new Error('PPP username must be a string of at most 256 characters.');
      }
      parameterValues.push([`${basePath}.Username`, username, 'xsd:string']);
    }
    if (password) {
      if (typeof password !== 'string' || password.length > 256) {
        throw new Error('PPP password must be a string of at most 256 characters.');
      }
      parameterValues.push([`${basePath}.Password`, password, 'xsd:string']);
    }
    
    const bindingPath = vendorObj?.lan_binding_path;
    if (bindingPath) {
      const fullBindingPath = this.resolveParameterPath(basePath, bindingPath);
      for (let i = 1; i <= 4; i++) {
        parameterValues.push([`${fullBindingPath}.Lan${i}Enable`, bindings[`LAN${i}`] ? 1 : 0, 'xsd:unsignedInt']);
      }
      for (let i = 1; i <= 8; i++) {
        parameterValues.push([`${fullBindingPath}.SSID${i}Enable`, bindings[`SSID${i}`] ? 1 : 0, 'xsd:unsignedInt']);
      }
    }

    if (parameterValues.length === 0) {
      throw new Error('No editable WAN parameters are configured for this vendor.');
    }

    await this.postTask(deviceId, {
      name: 'setParameterValues',
      parameterValues
    });

    return { success: true, message: 'WAN configuration updated. Device will refresh on next inform.' };
  }

  static async updateCredentials(deviceId, type, password) {
    if (typeof password !== 'string' || password.length < 1 || password.length > 256) {
      throw new Error('Password must be between 1 and 256 characters.');
    }
    const settings = await Setting.getAll();
    let passPath;

    if (type === 'super') {
      passPath = settings.vpSuperPassword;
    } else if (type === 'user') {
      passPath = settings.vpUserPassword;
    } else {
      throw new Error('Invalid credential type specified.');
    }

    if (!passPath) {
      throw new Error(`VirtualParameter path for ${type} password is not set in settings.`);
    }

    await this.postTask(deviceId, {
      name: 'setParameterValues',
      parameterValues: [
        [passPath, password, 'xsd:string']
      ]
    });

    return { success: true, message: `${type} admin password update task queued.` };
  }
}

export default DeviceService;

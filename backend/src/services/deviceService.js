import Setting from '../models/Setting.js';
import VendorService from './vendorService.js';
import Vendor from '../models/Vendor.js';
import WifiSecurityConfig from '../models/WifiSecurityConfig.js';
import { DEFAULT_SETTINGS } from '../config/seed.js';

class DeviceService {
  static dashboardCache = {
    data: null,
    expiresAt: 0,
    promise: null
  };

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
      return this.normalizeParameterValue(current._value);
    }
    return this.normalizeParameterValue(current);
  }

  static normalizeParameterValue(value) {
    if (value === null || value === undefined) return null;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[1] === 'string' &&
      /^(?:xsd:|xs:)/i.test(value[1])
    ) {
      return this.normalizeParameterValue(value[0]);
    }
    // GenieACS returns metadata-only nodes such as {_object, _writable} when a
    // projected parameter has no current value. These are not display values.
    if (typeof value === 'object') return null;
    return value;
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

  static async getGenieAcsRootUrl() {
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
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
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
    return `${await this.getGenieAcsRootUrl()}/devices`;
  }

  static async fetchGenieAcsCollection(collection, query = {}, method = 'GET', body = null, timeoutMs = 15_000) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(collection))) {
      throw new Error('Invalid GenieACS collection name');
    }
    const root = await this.getGenieAcsRootUrl();
    const url = new URL(`${root}/${collection}`);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const options = {
        method,
        headers: { Accept: 'application/json' },
        signal: controller.signal
      };
      if (body !== null && body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`GenieACS ${collection} API responded with status: ${response.status}${errorText ? ` - ${errorText}` : ''}`);
      }
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timeoutId);
    }
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

  static async getDashboardDevices() {
    const virtualParams = await this.getVirtualParameters();
    const projection = [
      '_id',
      '_deviceId._ProductClass',
      '_deviceId._Manufacturer',
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      virtualParams.vpActiveDevices,
      '_lastInform',
      '_registered'
    ].filter(Boolean);
    const data = await this.fetchFromGenieAcs(
      `?projection=${encodeURIComponent(projection.join(','))}`
    );
    if (!Array.isArray(data)) {
      throw new Error('Invalid GenieACS dashboard response');
    }
    return data.map((item) => this.processDeviceData(item, virtualParams));
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
        'VirtualParameters.SSID1-Name',
        'VirtualParameters.SSID1-Password',
        'VirtualParameters.SSID1-Security',
        'VirtualParameters.SSID5-Name',
        'VirtualParameters.SSID5-Password',
        'VirtualParameters.SSID5-Security',
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

    const getRelativeNode = (obj, path) => {
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
      return current ?? null;
    };

    const getRelativeValue = (obj, path) => {
      const current = getRelativeNode(obj, path);
      if (current && typeof current === 'object' && '_value' in current) {
        return this.normalizeParameterValue(current._value);
      }
      return this.normalizeParameterValue(current);
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
        if (ssidData && typeof ssidData === 'object' && !String(i).startsWith('_')) {
          const virtualPrefix = i === 1 ? 'SSID1' : i === 5 ? 'SSID5' : null;
          const virtualNamePath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Name` : null;
          const virtualPasswordPath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Password` : null;
          const virtualSecurityPath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Security` : null;
          const hasVirtualMapping = Boolean(
            virtualNamePath && this.getParameterNode(item, virtualNamePath)
          );
          const enableValue = getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Enable`);
          wifi.push({
            index: i,
            enable: enableValue === null ? null : this.isEnabledValue(enableValue),
            ssid: (virtualNamePath ? getValue(virtualNamePath) : null) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.SSID`),
            password: (virtualPasswordPath ? getValue(virtualPasswordPath) : null) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.PreSharedKey.1.KeyPassphrase`) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.KeyPassphrase`) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.PreSharedKey.1.PreSharedKey`),
            security: (virtualSecurityPath ? getValue(virtualSecurityPath) : null) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.BeaconType`),
            channel: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Channel`),
            totalAssociations: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.TotalAssociations`),
            usesVirtualParameters: hasVirtualMapping
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
                : getRelativeNode(connection, bindingPath);
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

  static resolveWifiConfiguredPath(basePath, configuredPath, index) {
    if (!configuredPath) return null;
    const expanded = String(configuredPath)
      .replaceAll('{index}', String(index))
      .replaceAll('{i}', String(index))
      .replace('*', String(index));
    return this.resolveParameterPath(basePath, expanded);
  }

  static async updateWifiConfig(deviceId, index, formData) {
    const wifiIndex = Number(index);
    if (!Number.isInteger(wifiIndex) || wifiIndex < 1 || wifiIndex > 8) {
      throw new Error('WiFi index must be an integer between 1 and 8.');
    }
    const ssid = String(formData?.ssid ?? '').trim();
    const password = formData?.password === undefined ? '' : String(formData.password);
    const security = String(formData?.security ?? '').trim();
    const channelRaw = formData?.channel;
    if (!ssid || ssid.length > 32) {
      throw new Error('WiFi SSID must contain 1 to 32 characters.');
    }
    if (password && (password.length < 8 || password.length > 63)) {
      throw new Error('WiFi password must contain 8 to 63 characters.');
    }
    if (security.length > 128) {
      throw new Error('WiFi security value is too long.');
    }
    if (
      channelRaw !== '' && channelRaw !== null && channelRaw !== undefined &&
      (!Number.isInteger(Number(channelRaw)) || Number(channelRaw) < 0 || Number(channelRaw) > 196)
    ) {
      throw new Error('WiFi channel must be an integer between 0 and 196.');
    }

    const rawDeviceData = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId })
    });
    if (!Array.isArray(rawDeviceData) || rawDeviceData.length === 0) {
      throw new Error('Device not found');
    }
    const item = rawDeviceData[0];
    const basePath = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${wifiIndex}`;
    const virtualPrefix = wifiIndex === 1 ? 'SSID1' : wifiIndex === 5 ? 'SSID5' : null;
    const virtualNamePath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Name` : null;
    const useVirtual = Boolean(virtualNamePath && this.getParameterNode(item, virtualNamePath));
    const productClass = this.normalizeParameterValue(item._deviceId?._ProductClass);
    const manufacturer = this.normalizeParameterValue(item._deviceId?._Manufacturer);
    const [productConfig, vendor] = await Promise.all([
      productClass ? WifiSecurityConfig.getByProductClass(productClass) : null,
      VendorService.detectVendor(manufacturer, productClass, item)
    ]);

    const parameterValues = [];
    const enablePath = `${basePath}.Enable`;
    if (typeof formData?.enable === 'boolean' && this.getParameterNode(item, enablePath)) {
      parameterValues.push([enablePath, formData.enable, 'xsd:boolean']);
    }
    parameterValues.push([
      useVirtual ? `VirtualParameters.${virtualPrefix}-Name` : `${basePath}.SSID`,
      ssid,
      'xsd:string'
    ]);
    if (password) {
      let passwordPath = useVirtual ? `VirtualParameters.${virtualPrefix}-Password` : null;
      if (!passwordPath) {
        passwordPath = this.resolveWifiConfiguredPath(
          basePath,
          productConfig?.password_param_path || vendor?.wifi_password_path,
          wifiIndex
        );
      }
      if (!passwordPath) {
        const candidates = [
          `${basePath}.PreSharedKey.1.KeyPassphrase`,
          `${basePath}.KeyPassphrase`,
          `${basePath}.PreSharedKey.1.PreSharedKey`
        ];
        passwordPath = candidates.find((path) => this.getParameterNode(item, path)) || candidates[0];
      }
      parameterValues.push([passwordPath, password, 'xsd:string']);
    }
    if (security) {
      parameterValues.push([
        useVirtual ? `VirtualParameters.${virtualPrefix}-Security` : `${basePath}.BeaconType`,
        security,
        'xsd:string'
      ]);
    }
    if (channelRaw !== '' && channelRaw !== null && channelRaw !== undefined) {
      const channelPath = `${basePath}.Channel`;
      if (this.getParameterNode(item, channelPath)) {
        parameterValues.push([channelPath, Number(channelRaw), 'xsd:unsignedInt']);
      }
    }

    await this.postTask(deviceId, {
      name: 'setParameterValues',
      parameterValues
    });
    return {
      success: true,
      message: `WiFi SSID ${wifiIndex} update task queued.`,
      parameterCount: parameterValues.length
    };
  }

  static normalizeFault(fault) {
    if (!fault || typeof fault !== 'object') return null;
    const id = this.normalizeParameterValue(fault._id);
    if (!id) return null;
    const detail = fault.detail && typeof fault.detail === 'object' ? fault.detail : {};
    const deviceId = this.normalizeParameterValue(fault.device) || String(id).split(':')[0] || null;
    const timestamp = this.normalizeParameterValue(fault.timestamp) ||
      this.normalizeParameterValue(fault.retryTimestamp) ||
      this.normalizeParameterValue(fault._timestamp) ||
      null;
    return {
      id: String(id),
      deviceId: deviceId ? String(deviceId) : null,
      channel: String(this.normalizeParameterValue(fault.channel) || String(id).split(':').slice(1).join(':') || 'default'),
      code: String(
        this.normalizeParameterValue(fault.code) ||
        this.normalizeParameterValue(detail.faultCode) ||
        this.normalizeParameterValue(detail.code) ||
        'FAULT'
      ),
      message: String(
        this.normalizeParameterValue(fault.message) ||
        this.normalizeParameterValue(detail.faultString) ||
        this.normalizeParameterValue(detail.message) ||
        'GenieACS reported a provisioning fault'
      ),
      timestamp: timestamp ? String(timestamp) : null,
      retries: Number(this.normalizeParameterValue(fault.retries) || 0)
    };
  }

  static async getFaults(limit = 50, timeoutMs = 15_000) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const data = await this.fetchGenieAcsCollection(
      'faults',
      {
        limit: safeLimit,
        sort: JSON.stringify({ timestamp: -1 })
      },
      'GET',
      null,
      timeoutMs
    );
    if (!Array.isArray(data)) {
      throw new Error('Invalid faults API response');
    }
    return data.map((fault) => this.normalizeFault(fault)).filter(Boolean);
  }

  static async deleteFault(faultId) {
    if (!faultId || String(faultId).length > 512) {
      throw new Error('Invalid fault ID');
    }
    const root = await this.getGenieAcsRootUrl();
    const url = `${root}/faults/${encodeURIComponent(String(faultId))}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { method: 'DELETE', signal: controller.signal });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`GenieACS fault API responded with status: ${response.status}${errorText ? ` - ${errorText}` : ''}`);
      }
      return true;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  static buildDashboardSummary(devices, faults = [], faultsError = null) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const stats = { total: devices.length, online: 0, offline: 0, new24h: 0 };
    const rxDistribution = { Excellent: 0, Good: 0, Poor: 0, Danger: 0, Unknown: 0 };
    const informFreshness = { 'Under 10m': 0, '10–60m': 0, '1–24h': 0, 'Over 24h': 0 };
    const temperatureDistribution = { Normal: 0, Warm: 0, Hot: 0, Unknown: 0 };
    const clientDistribution = { '0': 0, '1–5': 0, '6–15': 0, '16+': 0, Unknown: 0 };
    const productClasses = new Map();
    const manufacturers = new Map();
    const registrationDays = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(now - (6 - offset) * dayMs);
      return {
        key: date.toISOString().slice(0, 10),
        name: date.toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit' }),
        value: 0
      };
    });
    const registrationByKey = new Map(registrationDays.map((entry) => [entry.key, entry]));

    for (const device of devices) {
      const lastInformMs = device._lastInform ? new Date(device._lastInform).getTime() : Number.NaN;
      const informAge = now - lastInformMs;
      if (Number.isFinite(informAge) && informAge >= 0 && informAge < 10 * 60 * 1000) {
        stats.online += 1;
        informFreshness['Under 10m'] += 1;
      } else {
        stats.offline += 1;
        if (Number.isFinite(informAge) && informAge >= 0 && informAge < 60 * 60 * 1000) {
          informFreshness['10–60m'] += 1;
        } else if (Number.isFinite(informAge) && informAge >= 0 && informAge < dayMs) {
          informFreshness['1–24h'] += 1;
        } else {
          informFreshness['Over 24h'] += 1;
        }
      }

      const registeredMs = device._registered ? new Date(device._registered).getTime() : Number.NaN;
      if (Number.isFinite(registeredMs) && now - registeredMs >= 0 && now - registeredMs < dayMs) {
        stats.new24h += 1;
      }
      if (Number.isFinite(registeredMs)) {
        const registrationKey = new Date(registeredMs).toISOString().slice(0, 10);
        const registrationEntry = registrationByKey.get(registrationKey);
        if (registrationEntry) registrationEntry.value += 1;
      }

      const productClass = String(device.productclass || 'Unknown');
      const manufacturer = String(device.manufacturer || 'Unknown');
      productClasses.set(productClass, (productClasses.get(productClass) || 0) + 1);
      manufacturers.set(manufacturer, (manufacturers.get(manufacturer) || 0) + 1);

      const rxPower = Number(device.rxpower);
      if (device.rxpower === null || device.rxpower === undefined || !Number.isFinite(rxPower)) {
        rxDistribution.Unknown += 1;
      } else if (rxPower >= -21.99) {
        rxDistribution.Excellent += 1;
      } else if (rxPower >= -24.99) {
        rxDistribution.Good += 1;
      } else if (rxPower >= -26.99) {
        rxDistribution.Poor += 1;
      } else {
        rxDistribution.Danger += 1;
      }

      const temperature = Number(device.temperature);
      if (device.temperature === null || device.temperature === undefined || !Number.isFinite(temperature)) {
        temperatureDistribution.Unknown += 1;
      } else if (temperature < 50) {
        temperatureDistribution.Normal += 1;
      } else if (temperature < 70) {
        temperatureDistribution.Warm += 1;
      } else {
        temperatureDistribution.Hot += 1;
      }

      const clients = Number(device.activedevices);
      if (
        device.activedevices === null ||
        device.activedevices === undefined ||
        device.activedevices === '' ||
        !Number.isFinite(clients)
      ) clientDistribution.Unknown += 1;
      else if (clients <= 0) clientDistribution['0'] += 1;
      else if (clients <= 5) clientDistribution['1–5'] += 1;
      else if (clients <= 15) clientDistribution['6–15'] += 1;
      else clientDistribution['16+'] += 1;
    }

    const topEntries = (map, limit) => Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
      .slice(0, limit);

    return {
      stats,
      rxDistribution,
      informFreshness,
      temperatureDistribution,
      clientDistribution,
      productClasses: topEntries(productClasses, 10),
      manufacturers: topEntries(manufacturers, 8),
      registrations: registrationDays,
      faults,
      faultsError
    };
  }

  static async getDashboardData(force = false) {
    const cache = this.dashboardCache;
    if (!force && cache.data && cache.expiresAt > Date.now()) return cache.data;
    if (!force && cache.promise) return cache.promise;

    const work = (async () => {
      const [devicesResult, faultsResult] = await Promise.allSettled([
        this.getDashboardDevices(),
        this.getFaults(50, 1_500)
      ]);
      if (devicesResult.status === 'rejected') throw devicesResult.reason;
      const faults = faultsResult.status === 'fulfilled' ? faultsResult.value : [];
      const faultsError = faultsResult.status === 'rejected'
        ? 'Fault list could not be loaded from GenieACS.'
        : null;
      const data = this.buildDashboardSummary(devicesResult.value, faults, faultsError);
      cache.data = data;
      cache.expiresAt = Date.now() + 15_000;
      return data;
    })();
    cache.promise = work;
    try {
      return await work;
    } finally {
      if (cache.promise === work) cache.promise = null;
    }
  }
}

export default DeviceService;

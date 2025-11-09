import DeviceService from '../services/deviceService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

class DeviceController {
  static async getDevices(req, res) {
    try {
      const devices = await DeviceService.getDevices();
      return res.json(
        createResponse('Devices retrieved successfully', devices.reverse())
      );
    } catch (error) {
      console.error('Get devices error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get devices', error.message)
      );
    }
  }

  static async getDeviceDetail(req, res) {
    try {
      const { deviceId } = req.params;
      
      if (!deviceId) {
        return res.status(400).json(
          createErrorResponse('Device ID is required')
        );
      }

      const deviceDetail = await DeviceService.getDetailDevice(deviceId);
      return res.json(
        createResponse('Device detail retrieved successfully', deviceDetail)
      );
    } catch (error) {
      console.error('Get device detail error:', error);
      
      if (error.message === 'Device not found') {
        return res.status(404).json(
          createErrorResponse('Device not found', error.message)
        );
      }
      
      return res.status(500).json(
        createErrorResponse('Failed to get device detail', error.message)
      );
    }
  }

  static async deleteDevice(req, res) {
    try {
      const { deviceId } = req.params;
      
      if (!deviceId) {
        return res.status(400).json(
          createErrorResponse('Device ID is required')
        );
      }

      await DeviceService.deleteDevice(deviceId);
      return res.json(
        createResponse('Device deleted successfully', { deviceId })
      );
    } catch (error) {
      console.error('Delete device error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to delete device', error.message)
      );
    }
  }

  static async rebootDevice(req, res) {
    try {
      const { deviceId } = req.body;
      
      if (!deviceId) {
        return res.status(400).json(
          createErrorResponse('Device ID is required')
        );
      }

      const result = await DeviceService.rebootDevice(deviceId);
      return res.json(
        createResponse('Device reboot initiated successfully', { 
          deviceId, 
          taskResponse: result 
        })
      );
    } catch (error) {
      console.error('Reboot device error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to reboot device', error.message)
      );
    }
  }

  static async summonDevice(req, res) {
    try {
      const { deviceId, parameters = ['wifi', 'wan', 'virtual', 'system', 'hosts', 'credentials'] } = req.body;
      
      if (!deviceId) {
        return res.status(400).json(
          createErrorResponse('Device ID is required')
        );
      }

      const baseUrl = await DeviceService.getGenieAcsUrl();
      const virtualParams = await DeviceService.getVirtualParameters();
      
      const summonsToSend = [];
      const timestamp = Date.now();

      if (parameters.includes('virtual')) {
        summonsToSend.push(
          { name: virtualParams.vpPppoeUsername, timestamp },
          { name: virtualParams.vpWanBridge, timestamp },
          { name: virtualParams.vpRxPower, timestamp },
          { name: virtualParams.vpTemperature, timestamp },
          { name: virtualParams.vpActiveDevices, timestamp },
          { name: virtualParams.vpSuperAdmin, timestamp },
          { name: virtualParams.vpSuperPassword, timestamp },
          { name: virtualParams.vpUserAdmin, timestamp },
          { name: virtualParams.vpUserPassword, timestamp }
        );
      }

      if (parameters.includes('system')) {
        summonsToSend.push(
          { name: 'InternetGatewayDevice.DeviceInfo.HardwareVersion', timestamp },
          { name: 'InternetGatewayDevice.DeviceInfo.SoftwareVersion', timestamp },
          { name: 'InternetGatewayDevice.DeviceInfo.UpTime', timestamp },
          { name: 'InternetGatewayDevice.ManagementServer.ConnectionRequestURL', timestamp },
          { name: 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress', timestamp }
        );
      }

      if (parameters.includes('wifi')) {
        const maxWifiConfig = 8;
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
        
        summonsToSend.push(
          { name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.*.AssociatedDevice.*', timestamp }
        );
      }

      if (parameters.includes('hosts')) {
        summonsToSend.push(
          { name: 'InternetGatewayDevice.LANDevice.1.Hosts.Host', timestamp },
          { name: virtualParams.vpActiveDevices, timestamp }
        );
      }

      if (parameters.includes('credentials')) {
        summonsToSend.push(
          { name: virtualParams.vpSuperAdmin, timestamp },
          { name: virtualParams.vpSuperPassword, timestamp },
          { name: virtualParams.vpUserAdmin, timestamp },
          { name: virtualParams.vpUserPassword, timestamp }
        );
      }

      const encodedDeviceId = encodeURIComponent(deviceId);
      const summonUrl = `${baseUrl}/${encodedDeviceId}/tasks?connection_request`;

      const response = await fetch(summonUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          name: 'getParameterValues',
          parameterNames: summonsToSend.map(s => s.name)
        }),
        timeout: 30000
      });

      const result = await response.json().catch(() => null);

      return res.json(
        createResponse(`Summon sent successfully for ${summonsToSend.length} parameters`, {
          deviceId,
          parameterTypes: parameters,
          parameterCount: summonsToSend.length,
          taskId: result?._id || 'unknown'
        })
      );
    } catch (error) {
      console.error('Summon device error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to summon device', error.message)
      );
    }
  }

  static async updateWanConfig(req, res) {
    const { id } = req.params;
    const { wanIndex, formData } = req.body;
    
    if (!wanIndex || !formData) {
      return res.status(400).json({ success: false, message: 'Missing wanIndex or formData' });
    }

    try {
      const result = await DeviceService.updateWanConfig(id, wanIndex, formData);
      res.json({ success: true, data: result, message: 'WAN config update task queued.' });
    } catch (error) {
      console.error(`Error in updateWanConfig for ${id}:`, error);
      res.status(500).json({ success: false, message: 'Failed to update WAN config', error: error.message });
    }
  }

  static async updateCredentials(req, res) {
    const { id } = req.params;
    const { type, password } = req.body;

    if (!type || !password) {
      return res.status(400).json({ success: false, message: 'Missing type or password' });
    }

    try {
      const result = await DeviceService.updateCredentials(id, type, password);
      res.json({ success: true, data: result, message: result.message });
    } catch (error) {
      console.error(`Error in updateCredentials for ${id}:`, error);
      res.status(500).json({ success: false, message: 'Failed to update credentials', error: error.message });
    }
  }
}

export default DeviceController;
import DeviceService from '../services/deviceService.js';
import CustomerService from '../services/customerService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

class DeviceController {
  static async getDashboard(req, res) {
    try {
      const dashboard = await DeviceService.getDashboardData(req.query.refresh === '1');
      return res.json(createResponse('Dashboard data retrieved successfully', dashboard));
    } catch (error) {
      console.error('Get dashboard error:', error);
      return res.status(502).json(
        createErrorResponse('Failed to get dashboard data from GenieACS', error.message)
      );
    }
  }

  static async getFaults(req, res) {
    try {
      const faults = await DeviceService.getFaults(req.query.limit);
      void DeviceService.mergeDashboardFaults(faults);
      return res.json(createResponse('Faults retrieved successfully', faults));
    } catch (error) {
      console.error('Get faults error:', error);
      return res.status(502).json(
        createErrorResponse('Failed to get faults from GenieACS', error.message)
      );
    }
  }

  static async deleteFault(req, res) {
    try {
      await DeviceService.deleteFault(req.params.faultId);
      DeviceService.dashboardCache.expiresAt = 0;
      return res.json(createResponse('Fault cleared successfully'));
    } catch (error) {
      console.error('Delete fault error:', error);
      const validationError = error.message === 'Invalid fault ID';
      return res.status(validationError ? 400 : 502).json(
        createErrorResponse('Failed to clear GenieACS fault', error.message)
      );
    }
  }

  static async getDevices(req, res) {
    try {
      const devices = await DeviceService.getDevices();
      const decoratedDevices = await CustomerService.decorateDevices(devices);
      return res.json(
        createResponse('Devices retrieved successfully', decoratedDevices.reverse())
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
    const { deviceId, parameters = [] } = req.body;

    if (!deviceId) {
      return res.status(400).json(
        createErrorResponse('Device ID is required')
      );
    }

    try {
      const data = await DeviceService.summonDevice(deviceId, parameters);
      return res.json(
        createResponse('Device summon task queued.', data)
      );
    } catch (error) {
      console.error('Error summoning device:', error.message);
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
      const validationError = /^(Invalid|VLAN ID|PPP |No editable|Only PPPoE|Vendor not found)/.test(error.message);
      res.status(validationError ? 400 : 500).json(
        createErrorResponse('Failed to update WAN config', error.message)
      );
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
      const validationError = /^(Invalid credential|Password must|VirtualParameter path)/.test(error.message);
      res.status(validationError ? 400 : 500).json(
        createErrorResponse('Failed to update credentials', error.message)
      );
    }
  }

  static async updateWifiConfig(req, res) {
    const { id } = req.params;
    const { index, formData } = req.body || {};
    if (index === undefined || !formData) {
      return res.status(400).json(createErrorResponse('WiFi index and form data are required'));
    }
    try {
      const result = await DeviceService.updateWifiConfig(id, index, formData);
      DeviceService.dashboardCache.expiresAt = 0;
      return res.json(createResponse(result.message, result));
    } catch (error) {
      console.error(`Error in updateWifiConfig for ${id}:`, error);
      const validationError = /^(WiFi |Device not found)/.test(error.message);
      return res.status(validationError ? 400 : 500).json(
        createErrorResponse('Failed to update WiFi configuration', error.message)
      );
    }
  }
}

export default DeviceController;

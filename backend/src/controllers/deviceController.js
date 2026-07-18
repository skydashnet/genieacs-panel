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
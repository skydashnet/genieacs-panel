import Setting from '../models/Setting.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import CustomerService from '../services/customerService.js';
import DeviceService from '../services/deviceService.js';

const ALLOWED_SETTING_KEYS = new Set([
  'appName',
  'genieAcsUrl',
  'autoGenerateCustomerId',
  'vpPppoeUsername',
  'vpWanBridge',
  'vpRxPower',
  'vpTemperature',
  'vpActiveDevices',
  'vpSuperAdmin',
  'vpSuperPassword',
  'vpUserAdmin',
  'vpUserPassword'
]);

function validateSetting(key, value) {
  if (!ALLOWED_SETTING_KEYS.has(key)) {
    return { error: 'Unsupported setting key' };
  }
  const normalized = String(value);
  if (normalized.length > 2048) {
    return { error: 'Setting value is too long' };
  }
  if (key === 'autoGenerateCustomerId' && !['true', 'false'].includes(normalized)) {
    return { error: 'Auto generation must be true or false' };
  }
  if (key === 'appName' && (normalized.trim().length < 1 || normalized.length > 80)) {
    return { error: 'Application name must be between 1 and 80 characters' };
  }
  return { value: normalized };
}

function startCustomerSyncIfEnabled(key, value) {
  if (key !== 'autoGenerateCustomerId' || value !== 'true') return;
  void DeviceService.getCustomerIdentityDevices()
    .then((devices) => CustomerService.syncDevices(devices, { enabled: true }))
    .catch((error) => {
      console.warn(`Customer ID background sync skipped: ${error.message}`);
    });
}

class SettingsController {
  static async getAllSettings(req, res) {
    try {
      const settings = await Setting.getAll();
      return res.json(
        createResponse('Settings retrieved successfully', settings)
      );
    } catch (error) {
      console.error('Get all settings error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get settings', error.message)
      );
    }
  }

  static async getSettingByKey(req, res) {
    try {
      const { key } = req.params;
      
      if (!key) {
        return res.status(400).json(
          createErrorResponse('Setting key is required')
        );
      }
      if (!ALLOWED_SETTING_KEYS.has(key)) {
        return res.status(404).json(createErrorResponse('Setting not found'));
      }

      const value = await Setting.getByKey(key);
      
      if (value === null) {
        return res.status(404).json(
          createErrorResponse('Setting not found')
        );
      }

      return res.json(
        createResponse('Setting retrieved successfully', { [key]: value })
      );
    } catch (error) {
      console.error('Get setting error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get setting', error.message)
      );
    }
  }

  static async createSetting(req, res) {
    try {
      const { key, value } = req.body;
      
      if (!key || value === undefined || value === null) {
        return res.status(400).json(
          createErrorResponse('Key and value are required')
        );
      }

      const validated = validateSetting(String(key), value);
      if (validated.error) {
        return res.status(400).json(createErrorResponse(validated.error));
      }

      await Setting.create(key, validated.value);
      startCustomerSyncIfEnabled(key, validated.value);
      
      return res.json(
        createResponse('Setting created successfully', { [key]: validated.value })
      );
    } catch (error) {
      console.error('Create setting error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to create setting', error.message)
      );
    }
  }

  static async updateSetting(req, res) {
    try {
      const { key } = req.params;
      const { value } = req.body;
      
      if (!key || value === undefined || value === null) {
        return res.status(400).json(
          createErrorResponse('Key and value are required')
        );
      }

      const validated = validateSetting(String(key), value);
      if (validated.error) {
        return res.status(400).json(createErrorResponse(validated.error));
      }

      const updated = await Setting.update(key, validated.value);
      
      if (!updated) {
        return res.status(404).json(
          createErrorResponse('Setting not found')
        );
      }

      startCustomerSyncIfEnabled(key, validated.value);
      return res.json(
        createResponse('Setting updated successfully', { [key]: validated.value })
      );
    } catch (error) {
      console.error('Update setting error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update setting', error.message)
      );
    }
  }

  static async deleteSetting(req, res) {
    try {
      const { key } = req.params;
      
      if (!key) {
        return res.status(400).json(
          createErrorResponse('Setting key is required')
        );
      }
      if (!ALLOWED_SETTING_KEYS.has(key)) {
        return res.status(404).json(createErrorResponse('Setting not found'));
      }

      const deleted = await Setting.delete(key);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse('Setting not found')
        );
      }

      return res.json(
        createResponse('Setting deleted successfully')
      );
    } catch (error) {
      console.error('Delete setting error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to delete setting', error.message)
      );
    }
  }

  static async testGenieAcsConnection(req, res) {
    try {
      const { url } = req.body;
      
      if (!url) {
        return res.status(400).json(
          createErrorResponse('URL is required')
        );
      }
      
      let testUrl;
      try {
        testUrl = new URL(String(url).trim());
      } catch {
        return res.status(400).json(
          createErrorResponse('A valid HTTP or HTTPS URL is required')
        );
      }

      if (!['http:', 'https:'].includes(testUrl.protocol)) {
        return res.status(400).json(
          createErrorResponse('Only HTTP and HTTPS URLs are supported')
        );
      }

      if (testUrl.username || testUrl.password) {
        return res.status(400).json(
          createErrorResponse('Credentials in the URL are not supported')
        );
      }

      testUrl.pathname = '/devices';
      testUrl.search = '';
      testUrl.hash = '';
      testUrl.searchParams.set('limit', '1');
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      try {
        const response = await fetch(testUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          return res.status(502).json(
            createErrorResponse(`GenieACS server returned status ${response.status}`, 'Connection test failed')
          );
        }
        
        const data = await response.json();
        
        if (Array.isArray(data)) {
          return res.json(
            createResponse('Connection successful!', {
              deviceCount: data.length
            })
          );
        } else {
          return res.json(
            createResponse('Connection successful, but unexpected response format')
          );
        }
      } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError' || error.type === 'request-timeout') {
          return res.status(504).json(
            createErrorResponse('Connection timeout - GenieACS server did not respond')
          );
        }
        
        if (error.code === 'ECONNREFUSED') {
          return res.status(502).json(
            createErrorResponse('Connection refused - GenieACS server is not running or URL is incorrect')
          );
        }
        
        return res.status(502).json(
          createErrorResponse('Failed to connect to GenieACS server', error.message)
        );
      }
    } catch (error) {
      console.error('Test GenieACS connection error:', error);
      return res.status(500).json(
        createErrorResponse('Internal server error', error.message)
      );
    }
  }
}

export default SettingsController;

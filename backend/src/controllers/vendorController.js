import Vendor from '../models/Vendor.js';
import WifiSecurityConfig from '../models/WifiSecurityConfig.js';
import WifiSecurityMapping from '../models/WifiSecurityMapping.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

class VendorController {
  static async getAllVendors(req, res) {
    try {
      const vendors = await Vendor.getAll();
      return res.json(
        createResponse('Vendors retrieved successfully', vendors)
      );
    } catch (error) {
      console.error('Get all vendors error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get vendors', error.message)
      );
    }
  }

  static async getVendorById(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse('Vendor ID is required')
        );
      }

      const vendor = await Vendor.findById(id);
      
      if (!vendor) {
        return res.status(404).json(
          createErrorResponse('Vendor not found')
        );
      }

      return res.json(
        createResponse('Vendor retrieved successfully', vendor)
      );
    } catch (error) {
      console.error('Get vendor by ID error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get vendor', error.message)
      );
    }
  }

  static async createVendor(req, res) {
    try {
      const vendorData = req.body;
      
      if (!vendorData.name || !vendorData.manufacturer_patterns || !vendorData.product_patterns) {
        return res.status(400).json(
          createErrorResponse('Name, manufacturer_patterns, and product_patterns are required')
        );
      }

      const vendorId = await Vendor.create(vendorData);
      
      return res.status(201).json(
        createResponse('Vendor created successfully', { id: vendorId })
      );
    } catch (error) {
      console.error('Create vendor error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to create vendor', error.message)
      );
    }
  }

  static async updateVendor(req, res) {
    try {
      const { id } = req.params;
      const vendorData = req.body;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse('Vendor ID is required')
        );
      }

      const updated = await Vendor.update(id, vendorData);
      
      if (!updated) {
        return res.status(404).json(
          createErrorResponse('Vendor not found')
        );
      }

      return res.json(
        createResponse('Vendor updated successfully')
      );
    } catch (error) {
      console.error('Update vendor error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update vendor', error.message)
      );
    }
  }

  static async deleteVendor(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse('Vendor ID is required')
        );
      }

      const deleted = await Vendor.delete(id);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse('Vendor not found')
        );
      }

      return res.json(
        createResponse('Vendor deleted successfully')
      );
    } catch (error) {
      console.error('Delete vendor error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to delete vendor', error.message)
      );
    }
  }

  static async getWifiSecurityMappings(req, res) {
    try {
      const { vendorId } = req.params;
      
      if (!vendorId) {
        return res.status(400).json(
          createErrorResponse('Vendor ID is required')
        );
      }

      const mappings = await WifiSecurityMapping.getByVendor(vendorId);
      
      return res.json(
        createResponse('WiFi security mappings retrieved successfully', mappings)
      );
    } catch (error) {
      console.error('Get WiFi security mappings error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get WiFi security mappings', error.message)
      );
    }
  }

  static async createWifiSecurityMapping(req, res) {
    try {
      const { vendor_id, raw_security_value, normalized_security, description } = req.body;
      
      if (!vendor_id || !raw_security_value || !normalized_security) {
        return res.status(400).json(
          createErrorResponse('vendor_id, raw_security_value, and normalized_security are required')
        );
      }

      await WifiSecurityMapping.create({ vendor_id, raw_security_value, normalized_security, description });

      return res.status(201).json(
        createResponse('WiFi security mapping created successfully')
      );
    } catch (error) {
      console.error('Create WiFi security mapping error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to create WiFi security mapping', error.message)
      );
    }
  }

  static async updateWifiSecurityMapping(req, res) {
    try {
      const { id } = req.params;
      const { raw_security_value, normalized_security, description } = req.body;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse('Mapping ID is required')
        );
      }

      const updated = await WifiSecurityMapping.update(id, { raw_security_value, normalized_security, description });

      if (!updated) {
        return res.status(404).json(
          createErrorResponse('WiFi security mapping not found')
        );
      }

      return res.json(
        createResponse('WiFi security mapping updated successfully')
      );
    } catch (error) {
      console.error('Update WiFi security mapping error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update WiFi security mapping', error.message)
      );
    }
  }

  static async deleteWifiSecurityMapping(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse('Mapping ID is required')
        );
      }

      const deleted = await WifiSecurityMapping.delete(id);

      if (!deleted) {
        return res.status(404).json(
          createErrorResponse('WiFi security mapping not found')
        );
      }

      return res.json(
        createResponse('WiFi security mapping deleted successfully')
      );
    } catch (error) {
      console.error('Delete WiFi security mapping error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to delete WiFi security mapping', error.message)
      );
    }
  }

  static async getAllWifiSecurityConfigs(req, res) {
    try {
      const configs = await WifiSecurityConfig.getAll();
      return res.json(
        createResponse('WiFi security configs retrieved successfully', configs)
      );
    } catch (error) {
      console.error('Get all WiFi security configs error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get WiFi security configs', error.message)
      );
    }
  }

  static async getWifiSecurityConfigById(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse('Config ID is required')
        );
      }

      const config = await WifiSecurityConfig.getById(id);
      
      if (!config) {
        return res.status(404).json(
          createErrorResponse('WiFi security config not found')
        );
      }

      return res.json(
        createResponse('WiFi security config retrieved successfully', config)
      );
    } catch (error) {
      console.error('Get WiFi security config by ID error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get WiFi security config', error.message)
      );
    }
  }

  static async getWifiSecurityConfigByProductClass(req, res) {
    try {
      const { productClass } = req.params;

      if (!productClass) {
        return res.status(400).json(
          createErrorResponse('Product class is required')
        );
      }

      const config = await WifiSecurityConfig.getByProductClass(productClass);

      if (!config) {
        return res.status(404).json(
          createErrorResponse('WiFi security config not found for this product class')
        );
      }

      return res.json(
        createResponse('WiFi security config retrieved successfully', config)
      );
    } catch (error) {
      console.error('Get WiFi security config by product class error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get WiFi security config', error.message)
      );
    }
  }

  static async createWifiSecurityConfig(req, res) {
    try {
      const { product_class, security_types, password_param_path } = req.body;
      
      if (!product_class || !security_types || !password_param_path) {
        return res.status(400).json(
          createErrorResponse('Product class, security types, and password parameter path are required')
        );
      }

      const configId = await WifiSecurityConfig.create({
        product_class,
        security_types,
        password_param_path
      });
      
      return res.status(201).json(
        createResponse('WiFi security config created successfully', { id: configId })
      );
    } catch (error) {
      console.error('Create WiFi security config error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to create WiFi security config', error.message)
      );
    }
  }

  static async updateWifiSecurityConfig(req, res) {
    try {
      const { id } = req.params;
      const { product_class, security_types, password_param_path } = req.body;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse('Config ID is required')
        );
      }

      if (!product_class || !security_types || !password_param_path) {
        return res.status(400).json(
          createErrorResponse('Product class, security types, and password parameter path are required')
        );
      }

      const updated = await WifiSecurityConfig.update(id, {
        product_class,
        security_types,
        password_param_path
      });
      
      if (!updated) {
        return res.status(404).json(
          createErrorResponse('WiFi security config not found')
        );
      }

      return res.json(
        createResponse('WiFi security config updated successfully')
      );
    } catch (error) {
      console.error('Update WiFi security config error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update WiFi security config', error.message)
      );
    }
  }

  static async deleteWifiSecurityConfig(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse('Config ID is required')
        );
      }

      const deleted = await WifiSecurityConfig.delete(id);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse('WiFi security config not found')
        );
      }

      return res.json(
        createResponse('WiFi security config deleted successfully')
      );
    } catch (error) {
      console.error('Delete WiFi security config error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to delete WiFi security config', error.message)
      );
    }
  }
}

export default VendorController;
import { executeQuery } from '../config/database.js';

class Vendor {
  static async getAll() {
    const query = 'SELECT * FROM vendors WHERE enabled = 1 ORDER BY priority DESC, name ASC';
    const rows = await executeQuery(query);
    
    return rows.map(row => ({
      ...row,
      manufacturer_patterns: JSON.parse(row.manufacturer_patterns || '[]'),
      product_patterns: JSON.parse(row.product_patterns || '[]')
    }));
  }

  static async findById(id) {
    const query = 'SELECT * FROM vendors WHERE id = ?';
    const rows = await executeQuery(query, [id]);
    
    if (rows.length === 0) return null;
    
    const vendor = rows[0];
    return {
      ...vendor,
      manufacturer_patterns: JSON.parse(vendor.manufacturer_patterns || '[]'),
      product_patterns: JSON.parse(vendor.product_patterns || '[]')
    };
  }

  static async create(vendorData) {
    const {
      name,
      manufacturer_patterns,
      product_patterns,
      parameter_prefix,
      service_list_path,
      lan_binding_path,
      vlan_id_path,
      wifi_password_path,
      http_wan_enable_path,
      firewall_level_path,
      priority = 10,
      enabled = 1,
      description
    } = vendorData;

    const query = `
      INSERT INTO vendors (
        name, manufacturer_patterns, product_patterns, parameter_prefix,
        service_list_path, lan_binding_path, vlan_id_path, wifi_password_path,
        http_wan_enable_path, firewall_level_path,
        priority, enabled, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const result = await executeQuery(query, [
      name,
      JSON.stringify(manufacturer_patterns),
      JSON.stringify(product_patterns),
      parameter_prefix,
      service_list_path,
      lan_binding_path,
      vlan_id_path,
      wifi_password_path,
      http_wan_enable_path,
      firewall_level_path,
      priority,
      enabled,
      description
    ]);
    
    return result.insertId;
  }

  static async update(id, vendorData) {
    const {
      name,
      manufacturer_patterns,
      product_patterns,
      parameter_prefix,
      service_list_path,
      lan_binding_path,
      vlan_id_path,
      wifi_password_path,
      http_wan_enable_path,
      firewall_level_path,
      priority,
      enabled,
      description
    } = vendorData;

    const query = `
      UPDATE vendors SET 
        name = ?, manufacturer_patterns = ?, product_patterns = ?, parameter_prefix = ?,
        service_list_path = ?, lan_binding_path = ?, vlan_id_path = ?, wifi_password_path = ?,
        http_wan_enable_path = ?, firewall_level_path = ?,
        priority = ?, enabled = ?, description = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    
    const result = await executeQuery(query, [
      name,
      JSON.stringify(manufacturer_patterns),
      JSON.stringify(product_patterns),
      parameter_prefix,
      service_list_path,
      lan_binding_path,
      vlan_id_path,
      wifi_password_path,
      http_wan_enable_path,
      firewall_level_path,
      priority,
      enabled,
      description,
      id
    ]);
    
    return result.affectedRows > 0;
  }

  static async delete(id) {
    const query = 'DELETE FROM vendors WHERE id = ?';
    const result = await executeQuery(query, [id]);
    return result.affectedRows > 0;
  }

  static async getByPatterns(manufacturer, productClass) {
    const query = 'SELECT * FROM vendors WHERE enabled = 1 ORDER BY priority DESC, name ASC';
    const rows = await executeQuery(query);
    
    const vendors = rows.map(row => ({
      ...row,
      manufacturer_patterns: JSON.parse(row.manufacturer_patterns || '[]'),
      product_patterns: JSON.parse(row.product_patterns || '[]')
    }));

    for (const vendor of vendors) {
      if (manufacturer) {
        const manufacturerLower = manufacturer.toLowerCase();
        const matchesManufacturer = vendor.manufacturer_patterns.some(pattern => 
          manufacturerLower.includes(pattern.toLowerCase())
        );
        
        if (matchesManufacturer) {
          if (vendor.product_patterns.length > 0 && productClass) {
            const productClassLower = productClass.toLowerCase();
            const matchesProduct = vendor.product_patterns.some(pattern =>
              productClassLower.includes(pattern.toLowerCase())
            );
           
            if (matchesProduct) {
              return vendor;
            }
          } else if (vendor.product_patterns.length === 0) {
            return vendor;
          }
        }
      }
    }

    return null;
  }
}

export default Vendor;
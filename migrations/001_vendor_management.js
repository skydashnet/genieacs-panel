import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'database.sqlite');

/**
 * Migration Script: Vendor Management System
 * Creates 4 tables for database-driven vendor configuration
 */

async function runMigration() {
  const db = new sqlite3.Database(dbPath);

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Table 1: vendors
      db.run(`
        CREATE TABLE IF NOT EXISTS vendors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          manufacturer_patterns TEXT NOT NULL,
          product_patterns TEXT NOT NULL,
          priority INTEGER DEFAULT 10,
          enabled BOOLEAN DEFAULT 1,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('Error creating vendors table:', err);
          reject(err);
          return;
        }
        console.log('✓ Created vendors table');
      });

      // Table 2: vendor_sub_types
      db.run(`
        CREATE TABLE IF NOT EXISTS vendor_sub_types (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vendor_id INTEGER NOT NULL,
          sub_type_name TEXT NOT NULL,
          detection_patterns TEXT,
          parameter_prefix TEXT,
          priority INTEGER DEFAULT 10,
          enabled BOOLEAN DEFAULT 1,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
          UNIQUE(vendor_id, sub_type_name)
        )
      `, (err) => {
        if (err) {
          console.error('Error creating vendor_sub_types table:', err);
          reject(err);
          return;
        }
        console.log('✓ Created vendor_sub_types table');
      });

      // Table 3: vendor_parameters
      db.run(`
        CREATE TABLE IF NOT EXISTS vendor_parameters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vendor_id INTEGER NOT NULL,
          sub_type_id INTEGER,
          category TEXT NOT NULL,
          param_name TEXT NOT NULL,
          parameter_path TEXT NOT NULL,
          priority INTEGER DEFAULT 10,
          enabled BOOLEAN DEFAULT 1,
          fallback_to_null BOOLEAN DEFAULT 0,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
          FOREIGN KEY (sub_type_id) REFERENCES vendor_sub_types(id) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) {
          console.error('Error creating vendor_parameters table:', err);
          reject(err);
          return;
        }
        console.log('✓ Created vendor_parameters table');
      });

      // Table 4: wifi_security_mappings
      db.run(`
        CREATE TABLE IF NOT EXISTS wifi_security_mappings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vendor_id INTEGER NOT NULL,
          raw_security_value TEXT NOT NULL,
          normalized_security TEXT NOT NULL,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
          UNIQUE(vendor_id, raw_security_value)
        )
      `, (err) => {
        if (err) {
          console.error('Error creating wifi_security_mappings table:', err);
          reject(err);
          return;
        }
        console.log('✓ Created wifi_security_mappings table');
      });

      // Create indexes for better performance
      db.run('CREATE INDEX IF NOT EXISTS idx_vendor_enabled ON vendors(enabled)', (err) => {
        if (err) console.error('Error creating index:', err);
      });

      db.run('CREATE INDEX IF NOT EXISTS idx_vendor_sub_types_vendor ON vendor_sub_types(vendor_id)', (err) => {
        if (err) console.error('Error creating index:', err);
      });

      db.run('CREATE INDEX IF NOT EXISTS idx_vendor_parameters_vendor ON vendor_parameters(vendor_id, category)', (err) => {
        if (err) console.error('Error creating index:', err);
      });

      db.run('CREATE INDEX IF NOT EXISTS idx_wifi_mappings_vendor ON wifi_security_mappings(vendor_id)', (err) => {
        if (err) console.error('Error creating index:', err);
        else console.log('✓ Created indexes');
      });

      // Insert initial vendor data
      insertInitialData(db, () => {
        db.close((err) => {
          if (err) {
            console.error('Error closing database:', err);
            reject(err);
          } else {
            console.log('\n✅ Vendor Management Migration Completed Successfully!');
            resolve();
          }
        });
      });
    });
  });
}

/**
 * Insert initial vendor data
 */
function insertInitialData(db, callback) {
  console.log('\n📦 Inserting initial vendor data...');

  db.serialize(() => {
    // Insert Vendors
    const vendors = [
      { name: 'Huawei', manufacturer_patterns: JSON.stringify(['huawei', 'hw']), product_patterns: JSON.stringify(['eg8', 'hg8']), priority: 10, description: 'Huawei Technologies ONT devices' },
      { name: 'ZTE', manufacturer_patterns: JSON.stringify(['zte', 'zicg', 'ciot', 'ggcl']), product_patterns: JSON.stringify(['zx', 'f6', 'f660', 'f677']), priority: 10, description: 'ZTE Corporation ONT devices' },
      { name: 'FiberHome', manufacturer_patterns: JSON.stringify(['fiberhome', 'fh']), product_patterns: JSON.stringify(['an5506', 'hg6145']), priority: 10, description: 'FiberHome Telecommunication Technologies ONT devices' }
    ];

    const vendorStmt = db.prepare('INSERT INTO vendors (name, manufacturer_patterns, product_patterns, priority, description) VALUES (?, ?, ?, ?, ?)');
    vendors.forEach(v => {
      vendorStmt.run(v.name, v.manufacturer_patterns, v.product_patterns, v.priority, v.description);
    });
    vendorStmt.finalize();
    console.log('  ✓ Inserted 3 vendors');

    // Insert ZTE Sub-Types
    const subTypes = [
      { vendor_id: 2, sub_type_name: 'CT-COM', detection_patterns: JSON.stringify({ productClass: ['F660', 'F6600', 'ZXHN'] }), parameter_prefix: 'X_CT-COM', priority: 10, description: 'ZTE China Telecom variant' },
      { vendor_id: 2, sub_type_name: 'CMCC', detection_patterns: JSON.stringify({ productClass: ['F660V9', 'F677'] }), parameter_prefix: 'X_CMCC', priority: 9, description: 'ZTE China Mobile variant' },
      { vendor_id: 2, sub_type_name: 'Default', detection_patterns: JSON.stringify({}), parameter_prefix: 'X_CMCC', priority: 5, description: 'ZTE default fallback' }
    ];

    const subTypeStmt = db.prepare('INSERT INTO vendor_sub_types (vendor_id, sub_type_name, detection_patterns, parameter_prefix, priority, description) VALUES (?, ?, ?, ?, ?, ?)');
    subTypes.forEach(st => {
      subTypeStmt.run(st.vendor_id, st.sub_type_name, st.detection_patterns, st.parameter_prefix, st.priority, st.description);
    });
    subTypeStmt.finalize();
    console.log('  ✓ Inserted 3 ZTE sub-types');

    // Insert Vendor Parameters
    const parameters = [
      // Huawei Parameters
      { vendor_id: 1, sub_type_id: null, category: 'wan_connection', param_name: 'serviceList', parameter_path: 'X_HW_SERVICELIST', priority: 10, description: 'Huawei service list' },
      { vendor_id: 1, sub_type_id: null, category: 'wan_connection', param_name: 'lanBinding', parameter_path: 'X_HW_LANBIND', priority: 10, description: 'Huawei LAN binding config' },
      { vendor_id: 1, sub_type_id: null, category: 'wan_connection', param_name: 'vlanId', parameter_path: 'X_HW_VLAN', priority: 10, description: 'Huawei VLAN ID' },
      { vendor_id: 1, sub_type_id: null, category: 'wifi', param_name: 'passwordPath', parameter_path: 'PreSharedKey.1.KeyPassphrase', priority: 10, description: 'Huawei WiFi password path' },
      { vendor_id: 1, sub_type_id: null, category: 'security', param_name: 'httpWanEnable', parameter_path: 'InternetGatewayDevice.X_HW_Security.AclServices.HTTPWanEnable', priority: 10, description: 'Huawei HTTP WAN access' },
      { vendor_id: 1, sub_type_id: null, category: 'security', param_name: 'firewallLevel', parameter_path: 'InternetGatewayDevice.X_HW_Security.X_HW_FirewallLevel', priority: 10, description: 'Huawei firewall level' },
      
      // ZTE CT-COM Parameters
      { vendor_id: 2, sub_type_id: 1, category: 'wan_connection', param_name: 'serviceList', parameter_path: 'X_CT-COM_ServiceList', priority: 10, description: 'ZTE CT-COM service list' },
      { vendor_id: 2, sub_type_id: 1, category: 'wan_connection', param_name: 'lanInterface', parameter_path: 'X_CT-COM_LanInterface', priority: 10, description: 'ZTE CT-COM LAN interface' },
      { vendor_id: 2, sub_type_id: 1, category: 'wan_connection', param_name: 'vlanId', parameter_path: 'X_CT-COM_WANEponLinkConfig.VLANIDMark', priority: 10, description: 'ZTE CT-COM VLAN ID' },
      
      // ZTE CMCC Parameters
      { vendor_id: 2, sub_type_id: 2, category: 'wan_connection', param_name: 'serviceList', parameter_path: 'X_CMCC_ServiceList', priority: 10, description: 'ZTE CMCC service list' },
      { vendor_id: 2, sub_type_id: 2, category: 'wan_connection', param_name: 'lanInterface', parameter_path: 'X_CMCC_LanInterface', priority: 10, description: 'ZTE CMCC LAN interface' },
      { vendor_id: 2, sub_type_id: 2, category: 'wan_connection', param_name: 'vlanId', parameter_path: 'X_CMCC_WANEponLinkConfig.VLANIDMark', priority: 10, description: 'ZTE CMCC VLAN ID from WANEponLinkConfig' },
      { vendor_id: 2, sub_type_id: 2, category: 'wan_connection', param_name: 'vlanIdAlt', parameter_path: 'X_CMCC_VLANIDMark', priority: 9, description: 'ZTE CMCC VLAN ID alternative path' },
      
      // ZTE Common Parameters
      { vendor_id: 2, sub_type_id: null, category: 'wifi', param_name: 'passwordPath', parameter_path: 'KeyPassphrase', priority: 10, description: 'ZTE WiFi password path' },
      
      // FiberHome Parameters
      { vendor_id: 3, sub_type_id: null, category: 'wan_connection', param_name: 'serviceList', parameter_path: 'X_FH_ServiceList', priority: 10, description: 'FiberHome service list' },
      { vendor_id: 3, sub_type_id: null, category: 'wan_connection', param_name: 'lanInterface', parameter_path: 'X_FH_LanInterface', priority: 10, description: 'FiberHome LAN interface' },
      { vendor_id: 3, sub_type_id: null, category: 'wan_connection', param_name: 'vlanId', parameter_path: 'VLANID', priority: 10, description: 'FiberHome VLAN ID' },
      { vendor_id: 3, sub_type_id: null, category: 'wifi', param_name: 'passwordPath', parameter_path: 'KeyPassphrase', priority: 10, description: 'FiberHome WiFi password path' }
    ];

    const paramStmt = db.prepare('INSERT INTO vendor_parameters (vendor_id, sub_type_id, category, param_name, parameter_path, priority, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
    parameters.forEach(p => {
      paramStmt.run(p.vendor_id, p.sub_type_id, p.category, p.param_name, p.parameter_path, p.priority, p.description);
    });
    paramStmt.finalize();
    console.log('  ✓ Inserted ' + parameters.length + ' vendor parameters');

    // Insert WiFi Security Mappings
    const wifiSecurityMappings = [
      { vendor_id: 1, raw_security_value: 'WPAand11i', normalized_security: 'WPA2', description: 'Huawei WPA2 representation' },
      { vendor_id: 1, raw_security_value: '11i', normalized_security: 'WPA2', description: 'Huawei WPA2 short form' },
      { vendor_id: 2, raw_security_value: 'WPAand11i', normalized_security: 'WPA2', description: 'ZTE WPA2 representation (some models)' },
      { vendor_id: 2, raw_security_value: 'WPA/WPA2', normalized_security: 'WPA/WPA2', description: 'ZTE mixed mode (some models)' },
      { vendor_id: 2, raw_security_value: '11i', normalized_security: 'WPA2', description: 'ZTE WPA2 short form' },
      { vendor_id: 3, raw_security_value: 'WPAand11i', normalized_security: 'WPA2', description: 'FiberHome WPA2 representation' },
      { vendor_id: 3, raw_security_value: '11iandWPA2', normalized_security: 'WPA2', description: 'FiberHome WPA2 variant' },
      { vendor_id: 1, raw_security_value: 'None', normalized_security: 'Open', description: 'Open network' },
      { vendor_id: 2, raw_security_value: 'None', normalized_security: 'Open', description: 'Open network' },
      { vendor_id: 3, raw_security_value: 'None', normalized_security: 'Open', description: 'Open network' }
    ];

    const wifiStmt = db.prepare('INSERT INTO wifi_security_mappings (vendor_id, raw_security_value, normalized_security, description) VALUES (?, ?, ?, ?)');
    wifiSecurityMappings.forEach(w => {
      wifiStmt.run(w.vendor_id, w.raw_security_value, w.normalized_security, w.description);
    });
    wifiStmt.finalize();
    console.log('  ✓ Inserted ' + wifiSecurityMappings.length + ' WiFi security mappings');

    callback();
  });
}

// Run migration
runMigration()
  .then(() => {
    console.log('\n🎉 Migration completed successfully!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
  });

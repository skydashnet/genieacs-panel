/**
 * Migration: Simplify Vendor Management
 * 
 * Changes:
 * 1. Merge vendors + vendor_sub_types into single vendors table
 * 2. Add parameter path columns directly to vendors table
 * 3. Drop vendor_parameters table (parameters now in vendors table)
 * 4. Drop vendor_sub_types table (merged into vendors)
 * 
 * Before: 3 tables (vendors, vendor_sub_types, vendor_parameters)
 * After:  1 table (vendors)
 */

import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'database.sqlite');

async function migrate() {
  const db = new sqlite3.Database(dbPath);

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      console.log('Starting migration: Simplify Vendor Management...\n');

      // Step 1: Create new vendors table with all fields
      console.log('1. Creating new vendors table structure...');
      db.run(`
        CREATE TABLE IF NOT EXISTS vendors_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          manufacturer_patterns TEXT,
          product_patterns TEXT,
          parameter_prefix TEXT,
          
          -- WAN Connection Parameters
          service_list_path TEXT,
          lan_binding_path TEXT,
          vlan_id_path TEXT,
          
          -- WiFi Parameters
          wifi_password_path TEXT,
          
          -- Security Parameters
          http_wan_enable_path TEXT,
          firewall_level_path TEXT,
          
          priority INTEGER DEFAULT 10,
          enabled INTEGER DEFAULT 1,
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('Error creating vendors_new table:', err);
          reject(err);
          return;
        }
        console.log('✓ New vendors table created\n');

        // Step 2: Migrate data from old tables to new structure
        console.log('2. Migrating data...');
        
        // Huawei
        db.run(`
          INSERT INTO vendors_new (
            name, manufacturer_patterns, product_patterns, parameter_prefix,
            service_list_path, lan_binding_path, vlan_id_path,
            wifi_password_path, http_wan_enable_path, firewall_level_path,
            priority, enabled, description
          ) VALUES (
            'Huawei',
            '["huawei"]',
            '["eg8","hg8","hs8"]',
            'X_HW',
            'X_HW_SERVICELIST',
            'X_HW_LANBIND',
            'X_HW_VLAN',
            'PreSharedKey.1.KeyPassphrase',
            'InternetGatewayDevice.X_HW_Security.AclServices.HTTPWanEnable',
            'InternetGatewayDevice.X_HW_Security.X_HW_FirewallLevel',
            10, 1, 'Huawei Technologies ONT devices'
          )
        `);

        // ZTE CT-COM
        db.run(`
          INSERT INTO vendors_new (
            name, manufacturer_patterns, product_patterns, parameter_prefix,
            service_list_path, lan_binding_path, vlan_id_path,
            wifi_password_path, http_wan_enable_path, firewall_level_path,
            priority, enabled, description
          ) VALUES (
            'ZTE CT-COM',
            '["zte","zicg","ciot","ggcl","hwtc"]',
            '["f663nv3a","f6600","zxhn"]',
            'X_CT-COM',
            'X_CT-COM_ServiceList',
            'X_CT-COM_LanInterface',
            'X_CT-COM_WANEponLinkConfig.VLANIDMark',
            'KeyPassphrase',
            NULL,
            NULL,
            10, 1, 'ZTE China Telecom variant'
          )
        `);

        // ZTE CMCC
        db.run(`
          INSERT INTO vendors_new (
            name, manufacturer_patterns, product_patterns, parameter_prefix,
            service_list_path, lan_binding_path, vlan_id_path,
            wifi_password_path, http_wan_enable_path, firewall_level_path,
            priority, enabled, description
          ) VALUES (
            'ZTE CMCC',
            '["zte","zicg","ciot"]',
            '["f663nv9","f677"]',
            'X_CMCC',
            'X_CMCC_ServiceList',
            'X_CMCC_LanInterface',
            'X_CMCC_VLANID',
            'KeyPassphrase',
            NULL,
            NULL,
            9, 1, 'ZTE China Mobile variant'
          )
        `);

        // ZTE Default (Fallback)
        db.run(`
          INSERT INTO vendors_new (
            name, manufacturer_patterns, product_patterns, parameter_prefix,
            service_list_path, lan_binding_path, vlan_id_path,
            wifi_password_path, http_wan_enable_path, firewall_level_path,
            priority, enabled, description
          ) VALUES (
            'ZTE',
            '["zte"]',
            '[]',
            'X_CMCC',
            'X_CMCC_ServiceList',
            'X_CMCC_LanInterface',
            'X_CMCC_VLANID',
            'KeyPassphrase',
            NULL,
            NULL,
            5, 1, 'ZTE default fallback'
          )
        `);

        // FiberHome
        db.run(`
          INSERT INTO vendors_new (
            name, manufacturer_patterns, product_patterns, parameter_prefix,
            service_list_path, lan_binding_path, vlan_id_path,
            wifi_password_path, http_wan_enable_path, firewall_level_path,
            priority, enabled, description
          ) VALUES (
            'FiberHome',
            '["fh"]',
            '["an5506","hg6145"]',
            'X_FH',
            NULL,
            NULL,
            'VLANID',
            'KeyPassphrase',
            NULL,
            NULL,
            10, 1, 'FiberHome Telecommunication Technologies ONT devices'
          )
        `, (err) => {
          if (err) {
            console.error('Error migrating data:', err);
            reject(err);
            return;
          }
          console.log('✓ Data migrated to new structure\n');

          // Step 3: Backup old tables (rename with _old suffix)
          console.log('3. Backing up old tables...');
          
          db.run(`ALTER TABLE vendors RENAME TO vendors_old`, (err) => {
            if (err) {
              console.error('Error backing up vendors table:', err);
              reject(err);
              return;
            }

            db.run(`ALTER TABLE vendor_sub_types RENAME TO vendor_sub_types_old`, (err) => {
              if (err) {
                console.error('Error backing up vendor_sub_types table:', err);
                reject(err);
                return;
              }

              db.run(`ALTER TABLE vendor_parameters RENAME TO vendor_parameters_old`, (err) => {
                if (err) {
                  console.error('Error backing up vendor_parameters table:', err);
                  reject(err);
                  return;
                }
                console.log('✓ Old tables backed up (_old suffix)\n');

                // Step 4: Rename new table to vendors
                console.log('4. Activating new vendors table...');
                db.run(`ALTER TABLE vendors_new RENAME TO vendors`, (err) => {
                  if (err) {
                    console.error('Error renaming vendors_new to vendors:', err);
                    reject(err);
                    return;
                  }
                  console.log('✓ New vendors table activated\n');

                  // Step 5: Verify data
                  console.log('5. Verifying migration...');
                  db.all('SELECT id, name, parameter_prefix FROM vendors ORDER BY priority DESC, name', [], (err, rows) => {
                    if (err) {
                      console.error('Error verifying data:', err);
                      reject(err);
                      return;
                    }

                    console.log('✓ Migration successful!\n');
                    console.log('Vendors in new structure:');
                    console.table(rows);

                    console.log('\n📝 Note: Old tables backed up as:');
                    console.log('   - vendors_old');
                    console.log('   - vendor_sub_types_old');
                    console.log('   - vendor_parameters_old');
                    console.log('\n   You can drop them after testing:\n');
                    console.log('   DROP TABLE vendors_old;');
                    console.log('   DROP TABLE vendor_sub_types_old;');
                    console.log('   DROP TABLE vendor_parameters_old;\n');

                    db.close();
                    resolve();
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

// Run migration
migrate()
  .then(() => {
    console.log('✅ Migration completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });

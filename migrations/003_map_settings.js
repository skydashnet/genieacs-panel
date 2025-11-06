import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'database.sqlite');

/**
 * Migration Script: Map Settings
 * Creates table for storing map configuration (center coordinates and zoom levels)
 */

async function runMigration() {
  const db = new sqlite3.Database(dbPath);

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Create map_settings table
      db.run(`
        CREATE TABLE IF NOT EXISTS map_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          center_lat TEXT DEFAULT '-6.2088',
          center_lng TEXT DEFAULT '106.8456',
          max_zoom_in TEXT DEFAULT '18',
          max_zoom_out TEXT DEFAULT '5',
          default_zoom TEXT DEFAULT '13',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('Error creating map_settings table:', err);
          reject(err);
          return;
        }
        console.log('✓ Created map_settings table');
        
        // Insert default map settings
        db.run(`
          INSERT OR IGNORE INTO map_settings (id, center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom)
          VALUES (1, '-6.2088', '106.8456', '18', '5', '13')
        `, (err) => {
          if (err) {
            console.error('Error inserting default map settings:', err);
            reject(err);
            return;
          }
          console.log('✓ Inserted default map settings');
          
          db.close((err) => {
            if (err) {
              console.error('Error closing database:', err);
              reject(err);
            } else {
              console.log('\n✅ Map Settings Migration Completed Successfully!');
              resolve();
            }
          });
        });
      });
    });
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

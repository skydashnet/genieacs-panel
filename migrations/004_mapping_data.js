import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'database.sqlite');

/**
 * Migration Script: Mapping Data
 * Creates tables for storing network mapping nodes and edges (fiber connections)
 */

async function runMigration() {
  const db = new sqlite3.Database(dbPath);

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Create mapping_nodes table
      db.run(`
        CREATE TABLE IF NOT EXISTS mapping_nodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id TEXT UNIQUE NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('server', 'odc', 'odp', 'ont')),
          name TEXT NOT NULL,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          capacity INTEGER,
          splitter TEXT,
          pppoe TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('Error creating mapping_nodes table:', err);
          reject(err);
          return;
        }
        console.log('✓ Created mapping_nodes table');
        
        // Create mapping_edges table
        db.run(`
          CREATE TABLE IF NOT EXISTS mapping_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            edge_id TEXT UNIQUE NOT NULL,
            source TEXT NOT NULL,
            target TEXT NOT NULL,
            fiber_type TEXT CHECK(fiber_type IN ('feeder', 'distribution', 'drop')),
            distance REAL,
            waypoints TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (source) REFERENCES mapping_nodes(node_id) ON DELETE CASCADE,
            FOREIGN KEY (target) REFERENCES mapping_nodes(node_id) ON DELETE CASCADE
          )
        `, (err) => {
          if (err) {
            console.error('Error creating mapping_edges table:', err);
            reject(err);
            return;
          }
          console.log('✓ Created mapping_edges table');
          
          // Create indexes for better performance
          db.run(`
            CREATE INDEX IF NOT EXISTS idx_mapping_nodes_node_id ON mapping_nodes(node_id)
          `, (err) => {
            if (err) {
              console.error('Error creating node_id index:', err);
              reject(err);
              return;
            }
            console.log('✓ Created index on mapping_nodes.node_id');
            
            db.run(`
              CREATE INDEX IF NOT EXISTS idx_mapping_nodes_type ON mapping_nodes(type)
            `, (err) => {
              if (err) {
                console.error('Error creating type index:', err);
                reject(err);
                return;
              }
              console.log('✓ Created index on mapping_nodes.type');
              
              db.run(`
                CREATE INDEX IF NOT EXISTS idx_mapping_edges_source ON mapping_edges(source)
              `, (err) => {
                if (err) {
                  console.error('Error creating source index:', err);
                  reject(err);
                  return;
                }
                console.log('✓ Created index on mapping_edges.source');
                
                db.run(`
                  CREATE INDEX IF NOT EXISTS idx_mapping_edges_target ON mapping_edges(target)
                `, (err) => {
                  if (err) {
                    console.error('Error creating target index:', err);
                    reject(err);
                    return;
                  }
                  console.log('✓ Created index on mapping_edges.target');
                  
                  db.close((err) => {
                    if (err) {
                      console.error('Error closing database:', err);
                      reject(err);
                    } else {
                      console.log('\n✅ Mapping Data Migration Completed Successfully!');
                      resolve();
                    }
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
runMigration()
  .then(() => {
    console.log('\n🎉 Migration completed successfully!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
  });

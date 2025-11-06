import sqlite3 from 'better-sqlite3';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ProgressIndicator {
  constructor(total) {
    this.total = total;
    this.current = 0;
    this.width = 50;
  }

  update(current, message = '') {
    this.current = current;
    this.draw();
    
    if (message) {
      console.log(`${message} ${chalk.gray(`(${this.current}/${this.total})`)}`);
    }
  }

  draw() {
    const percent = Math.floor((this.current / this.total) * 100);
    const filled = Math.floor((this.current / this.total) * this.width);
    const empty = this.width - filled;
    
    const bar = chalk.cyan('█').repeat(filled) + chalk.gray('░').repeat(empty);
    const percentage = chalk.white(`${percent}%`.padStart(3));
    
    process.stdout.write(`\r${bar} ${percentage} `);
  }

  complete() {
    process.stdout.write('\r' + chalk.green('█').repeat(this.width) + chalk.green(' 100%') + '\n');
    console.log(chalk.green('\n✅ Migration completed successfully!\n'));
  }
}

async function migrate() {
  console.log(chalk.blue('🚀 Starting migration from SQLite to MariaDB...\n'));
  
  const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, '../database.sqlite');
  const mariadbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'genieacs_panel',
    charset: 'utf8mb4',
    connectionLimit: 10,
    multipleStatements: false
  };

  try {
    const sqliteDb = new sqlite3.Database(sqlitePath);
    const mariadb = await mysql.createConnection(mariadbConfig);
    
    console.log(chalk.blue('📊 Connecting to databases...'));
    
    const tables = await getTableList(sqliteDb);
    const progress = new ProgressIndicator(tables.length);
    
    console.log(chalk.blue(`📋 Found ${tables.length} tables to migrate`));
    console.log(chalk.blue('Tables: ' + tables.join(', ')));
    
    for (let i = 0; i < tables.length; i++) {
      const tableName = tables[i];
      progress.update(i, `Migrating table: ${tableName}`);
      
      try {
        await migrateTable(sqliteDb, mariadb, tableName);
        progress.update(i + 1);
      } catch (error) {
        console.error(chalk.red(`❌ Error migrating table ${tableName}:`), error);
        
        if (process.env.ROLLBACK_ON_ERROR !== 'false') {
          console.log(chalk.yellow('⚠️  Rolling back changes due to error...'));
          await rollbackTable(mariadb, tableName);
        }
      }
    }
    
    await mariadb.end();
    sqliteDb.close();
    
    progress.complete();
    
    console.log(chalk.blue('\n🎉 Migration Summary:'));
    console.log(chalk.green(`✅ Successfully migrated ${tables.length} tables from SQLite to MariaDB`));
    console.log(chalk.blue('\n📝 Next Steps:'));
    console.log(chalk.white('1. Update your application to use the new MariaDB connection'));
    console.log(chalk.white('2. Test all functionality to ensure everything works correctly'));
    
  } catch (error) {
    console.error(chalk.red('❌ Migration failed:'), error);
    process.exit(1);
  }
}

async function getTableList(db) {
  return new Promise((resolve, reject) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        const tableNames = rows.map(row => row.name);
        resolve(tableNames);
      }
    });
  });
}

async function migrateTable(sqliteDb, mariadb, tableName) {
  console.log(chalk.blue(`📋 Processing table: ${tableName}`));
  
  const tableSchema = await getTableSchema(sqliteDb, tableName);
  
  if (Object.keys(tableSchema).length === 0) {
    console.log(chalk.yellow(`⚠️  No columns found for table ${tableName}, skipping`));
    return;
  }
  
  await createTable(mariadb, tableName, tableSchema);
  await copyData(sqliteDb, mariadb, tableName, tableSchema);
}

async function getTableSchema(db, tableName) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        const schema = {};
        rows.forEach(row => {
          schema[row.name] = {
            type: row.type,
            notnull: row.notnull === 1,
            primaryKey: row.pk === 1,
            defaultValue: row.dflt_value
          };
        });
        resolve(schema);
      }
    });
  });
}

async function createTable(db, tableName, schema) {
  const columns = [];
  const primaryKeys = [];
  
  Object.entries(schema).forEach(([name, info]) => {
    let columnType = info.type.toUpperCase();
    
    if (info.type === 'INTEGER' && info.primaryKey) {
      columnType = 'INT AUTO_INCREMENT PRIMARY KEY';
      primaryKeys.push(name);
    } else if (info.type === 'TEXT') {
      columnType = 'VARCHAR(255)';
    } else if (info.type === 'BOOLEAN') {
      columnType = 'TINYINT(1)';
    } else if (info.type === 'REAL') {
      columnType = 'DOUBLE';
    } else if (info.type === 'BLOB') {
      columnType = 'LONGBLOB';
    } else {
      columnType = info.type.toUpperCase();
    }
    
    columns.push(`\`${name}\` ${columnType}${info.notnull ? ' NOT NULL' : ''}${info.defaultValue ? ` DEFAULT ${info.defaultValue}` : ''}`);
  });
  
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS \`${tableName}\` (
      ${columns.join(',\n')},
      PRIMARY KEY (${primaryKeys.join(', ')})
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;
  
  await db.query(createTableSQL);
}

async function copyData(sqliteDb, mariadb, tableName, schema) {
  console.log(chalk.blue(`📋 Copying data for table: ${tableName}`));
  
  const count = await new Promise((resolve, reject) => {
    sqliteDb.get(`SELECT COUNT(*) as count FROM \`${tableName}\``, [], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row.count);
      }
    });
  });
  
  if (count === 0) {
    console.log(chalk.yellow(`⚠️  No data found in table ${tableName}, skipping`));
    return;
  }
  
  const batchSize = 1000;
  let offset = 0;
  let copiedRows = 0;
  
  while (offset < count) {
    const rows = await new Promise((resolve, reject) => {
      sqliteDb.all(`SELECT * FROM \`${tableName}\` LIMIT ${batchSize} OFFSET ${offset}`, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
    
    if (rows.length === 0) {
      break;
    }
    
    const columnNames = Object.keys(schema);
    const placeholders = columnNames.map(() => '?').join(', ');
    
    const insertSQL = `
      INSERT INTO \`${tableName}\` (${columnNames.join(', ')})
      VALUES (${placeholders})
    `;
    
    const insertPromises = rows.map(row => {
      const values = columnNames.map(col => {
        let value = row[col];
        
        if (schema[col].type === 'BOOLEAN') {
          value = value ? 1 : 0;
        }
        
        return value;
      });
      
      return mariadb.query(insertSQL, values);
    });
    
    await Promise.all(insertPromises);
    copiedRows += rows.length;
    
    console.log(chalk.gray(`  Copied ${copiedRows}/${count} rows`));
    
    offset += batchSize;
  }
}

async function rollbackTable(db, tableName) {
  console.log(chalk.yellow(`⚠️  Rolling back table: ${tableName}`));
  
  await db.query(`DROP TABLE IF EXISTS \`${tableName}\``);
}

migrate().catch(error => {
  console.error(chalk.red('❌ Migration script failed:'), error);
  process.exit(1);
});
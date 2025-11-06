import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'genieacs_panel',
  charset: 'utf8mb4'
};

async function migrate() {
  let connection;
  
  try {
    console.log('Connecting to database...');
    connection = await mysql.createConnection(dbConfig);
    
    console.log('Creating database if not exists...');
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.changeUser({ database: dbConfig.database });
    
    console.log('Creating tables...');
    
    // Users table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('admin', 'user') DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Settings table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        \`key\` VARCHAR(100) UNIQUE NOT NULL,
        value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Vendors table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS vendors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        manufacturer_patterns JSON,
        product_patterns JSON,
        parameter_prefix VARCHAR(100),
        service_list_path VARCHAR(255),
        lan_binding_path VARCHAR(255),
        vlan_id_path VARCHAR(255),
        wifi_password_path VARCHAR(255),
        http_wan_enable_path VARCHAR(255),
        firewall_level_path VARCHAR(255),
        priority INT DEFAULT 10,
        enabled TINYINT(1) DEFAULT 1,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // WiFi Security Config table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS wifi_security_config (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_class VARCHAR(100) NOT NULL,
        security_types VARCHAR(255),
        password_param_path VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // WiFi Security Mappings table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS wifi_security_mappings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        raw_security_value VARCHAR(100) NOT NULL,
        normalized_security VARCHAR(50) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
      )
    `);
    
    // Map Settings table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS map_settings (
        id INT PRIMARY KEY DEFAULT 1,
        center_lat VARCHAR(20) DEFAULT '-6.2088',
        center_lng VARCHAR(20) DEFAULT '106.8456',
        max_zoom_in VARCHAR(10) DEFAULT '18',
        max_zoom_out VARCHAR(10) DEFAULT '5',
        default_zoom VARCHAR(10) DEFAULT '13',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Mapping Nodes table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS mapping_nodes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        node_id VARCHAR(50) UNIQUE NOT NULL,
        type ENUM('server', 'odc', 'odp', 'ont') NOT NULL,
        name VARCHAR(100) NOT NULL,
        latitude DECIMAL(10, 8) NOT NULL,
        longitude DECIMAL(11, 8) NOT NULL,
        capacity INT,
        splitter VARCHAR(20),
        pppoe VARCHAR(100),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Mapping Edges table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS mapping_edges (
        id INT AUTO_INCREMENT PRIMARY KEY,
        edge_id VARCHAR(50) UNIQUE NOT NULL,
        source VARCHAR(50) NOT NULL,
        target VARCHAR(50) NOT NULL,
        fiber_type ENUM('feeder', 'distribution', 'drop'),
        distance DECIMAL(10, 2),
        waypoints JSON,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Insert default admin user (password: admin123)
    const bcrypt = await import('bcryptjs');
    const hashedPassword = await bcrypt.hash('admin123', 12);
    
    await connection.query(`
      INSERT IGNORE INTO users (username, password, role) 
      VALUES ('admin', ?, 'admin')
    `, [hashedPassword]);
    
    // Insert default settings
    await connection.query(`
      INSERT IGNORE INTO settings (\`key\`, value) VALUES
      ('appName', 'GenieACS Panel'),
      ('genieAcsUrl', 'http://localhost:7557/devices'),
      ('vpPppoeUsername', 'VirtualParameters.pppoeUsername'),
      ('vpWanBridge', 'VirtualParameters.WANBRIDGE'),
      ('vpRxPower', 'VirtualParameters.RXPower'),
      ('vpTemperature', 'VirtualParameters.gettemp'),
      ('vpActiveDevices', 'VirtualParameters.activedevices'),
      ('vpSuperAdmin', 'VirtualParameters.superAdmin'),
      ('vpSuperPassword', 'VirtualParameters.superPassword'),
      ('vpUserAdmin', 'VirtualParameters.userAdmin'),
      ('vpUserPassword', 'VirtualParameters.userPassword')
    `);
    
    // Insert default map settings
    await connection.query(`
      INSERT IGNORE INTO map_settings (id, center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom)
      VALUES (1, '-6.2088', '106.8456', '18', '5', '13')
    `);
    
    console.log('Migration completed successfully!');
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('Database connection closed.');
    }
  }
}

// Run migration if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
}

export default migrate;
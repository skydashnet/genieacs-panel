import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'genieacs_panel',
  charset: 'utf8mb4',
  connectionLimit: 10,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true,
  multipleStatements: false
};

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
    
    pool.on('connection', (connection) => {
      console.log('New database connection established');
    });
    
    pool.on('error', (err) => {
      console.error('Database pool error:', err);
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        console.log('Attempting to reconnect to database...');
      }
    });
  }
  return pool;
}

async function getConnection() {
  try {
    const connection = await getPool().getConnection();
    return connection;
  } catch (error) {
    console.error('Error getting database connection:', error);
    throw error;
  }
}

async function executeQuery(query, params = []) {
  let connection;
  try {
    connection = await getConnection();
    const [rows] = await connection.execute(query, params);
    return rows;
  } catch (error) {
    console.error('Error executing query:', error);
    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

async function executeTransaction(queries) {
  let connection;
  try {
    connection = await getConnection();
    await connection.beginTransaction();
    
    const results = [];
    for (const { query, params = [] } of queries) {
      const [rows] = await connection.execute(query, params);
      results.push(rows);
    }
    
    await connection.commit();
    return results;
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Transaction error:', error);
    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

async function testConnection() {
  try {
    const connection = await getConnection();
    await connection.ping();
    console.log('Database connection successful');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    console.log('Database pool closed');
  }
}

export {
  getPool,
  getConnection,
  executeQuery,
  executeTransaction,
  testConnection,
  closePool
};
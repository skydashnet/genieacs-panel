import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  // Pool options (valid for mysql2)
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_MAX) || 10,
  queueLimit: 0,
  // Connection options (valid for mysql2)
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 60000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
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

async function getConnection(retries = 5, delayMs = 3000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const connection = await getPool().getConnection();
      return connection;
    } catch (error) {
      lastError = error;
      const code = error && (error.code || error.errno) ? (error.code || error.errno) : error?.message;
      if (attempt === retries) {
        console.error('Error getting database connection:', error);
        break;
      }
      console.warn(`DB connection attempt ${attempt} failed (${code}). Retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
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
  let connection;
  try {
    connection = await getConnection();
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
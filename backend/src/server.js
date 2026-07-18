import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { testConnection } from './config/database.js';
import { ensureSchema } from './config/schema.js';
import { seedDefaults } from './config/seed.js';

import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import settingsRoutes from './routes/settings.js';
import vendorRoutes from './routes/vendors.js';
import mappingRoutes from './routes/mapping.js';
import mapSettingsRoutes from './routes/mapSettings.js';
import databaseRoutes from './routes/database.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.APP_PORT) || 5890;
const HOST = process.env.APP_HOST || '127.0.0.1';
const APP_ENV = process.env.APP_ENV || 'development';
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, '..', '..', 'frontend', 'out');

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5890')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '1mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, please try again later' }
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/refresh', authLimiter);
app.use('/api/auth/setup', authLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/vendor-management', vendorRoutes);
app.use('/api/mapping-data', mappingRoutes);
app.use('/api/map-settings', mapSettingsRoutes);
app.use('/api/database', databaseRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: APP_ENV
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.use((req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
} else {
  console.warn(`Frontend build not found at ${FRONTEND_DIR}; serving API only`);
}

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

const startServer = async () => {
  try {
    const dbConnected = await testConnection();

    if (!dbConnected) {
      console.error('Failed to connect to database');
      process.exit(1);
    }

    await ensureSchema();
    await seedDefaults();

    app.listen(PORT, HOST, () => {
      console.log(`Server running on ${HOST}:${PORT} (${APP_ENV})`);
      console.log(`Panel: http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;

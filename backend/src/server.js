import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { closePool, testConnection } from './config/database.js';
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

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // Next.js static exports embed hydration/redirect state in inline scripts.
      // Keep script attributes blocked while allowing only those script blocks.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      // The built-in server defaults to HTTP; upgrading relative assets would
      // make browsers request HTTPS from a port that has no TLS listener.
      upgradeInsecureRequests: null,
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://*.tile.openstreetmap.org',
        'https://*.basemaps.cartocdn.com'
      ]
    }
  }
}));

function isAllowedOrigin(req, origin) {
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;

  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (!isAllowedOrigin(req, origin)) {
    return res.status(403).json({
      success: false,
      message: 'Origin is not allowed'
    });
  }
  return next();
});

app.use(cors({
  origin: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
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

app.get('/api/health', async (req, res) => {
  const database = await testConnection();
  res.status(database ? 200 : 503).json({
    status: database ? 'ok' : 'degraded',
    database: database ? 'ok' : 'unavailable',
    timestamp: new Date().toISOString(),
    environment: APP_ENV
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR, {
    maxAge: APP_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}_next${path.sep}static${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html') || filePath.endsWith('.txt')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || path.extname(req.path)) {
      return next();
    }
    return res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
} else {
  console.warn(`Frontend build not found at ${FRONTEND_DIR}; serving API only`);
}

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      message: 'Invalid JSON request body'
    });
  }
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: status >= 500 && APP_ENV === 'production'
      ? 'Internal server error'
      : (err.message || 'Internal server error')
  });
});

let server;

export const startServer = async () => {
  try {
    const dbConnected = await testConnection();

    if (!dbConnected) {
      console.error('Failed to connect to database');
      process.exit(1);
    }

    await ensureSchema();
    await seedDefaults();

    server = app.listen(PORT, HOST, () => {
      console.log(`Server running on ${HOST}:${PORT} (${APP_ENV})`);
      console.log(`Panel: http://localhost:${PORT}`);
    });
    return server;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await closePool();
  process.exit(0);
}

process.once('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('Graceful shutdown failed:', error);
    process.exit(1);
  });
});
process.once('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error('Graceful shutdown failed:', error);
    process.exit(1);
  });
});

export default app;

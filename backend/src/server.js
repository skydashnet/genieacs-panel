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
import DeviceService from './services/deviceService.js';
import CustomerService from './services/customerService.js';

import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import settingsRoutes from './routes/settings.js';
import vendorRoutes from './routes/vendors.js';
import mappingRoutes from './routes/mapping.js';
import mapSettingsRoutes from './routes/mapSettings.js';
import databaseRoutes from './routes/database.js';
import customerPortalRoutes from './routes/customerPortal.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const portalApp = express();
const PORT = Number(process.env.APP_PORT) || 5890;
const PORTAL_PORT = process.env.PORTAL_PORT === '0'
  ? 0
  : (Number(process.env.PORTAL_PORT) || 5891);
const HOST = process.env.APP_HOST || '127.0.0.1';
const PORTAL_HOST = process.env.PORTAL_HOST || HOST;
const APP_ENV = process.env.APP_ENV || 'development';
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, '..', '..', 'frontend', 'dist');
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
).version;

if (PORT !== 0 && PORTAL_PORT !== 0 && PORT === PORTAL_PORT && HOST === PORTAL_HOST) {
  throw new Error('APP_PORT and PORTAL_PORT must be different when using the same host');
}

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5890')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const helmetOptions = {
  // COOP is ignored on plain HTTP public-IP deployments and OAC can produce
  // persistent browser warnings when an origin previously used site-keying.
  // SkyGenPanel does not rely on cross-origin isolation, so omit both headers.
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin'
  },
  contentSecurityPolicy: {
    directives: {
      // Vite emits external hashed modules, so inline scripts remain blocked.
      scriptSrc: ["'self'"],
      // The built-in server defaults to HTTP; upgrading relative assets would
      // make browsers request HTTPS from a port that has no TLS listener.
      upgradeInsecureRequests: null,
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://tile.openstreetmap.org',
        'https://*.basemaps.cartocdn.com',
        'https://mt1.google.com'
      ],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  }
};

function configureSecurity(target) {
  target.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') {
    target.set('trust proxy', 1);
  }
  target.use(helmet(helmetOptions));
  target.use((req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()'
    );
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });
}

configureSecurity(app);
configureSecurity(portalApp);

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

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, please try again later' }
});

app.use('/api', apiLimiter);
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
    version: APP_VERSION
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR, {
    dotfiles: 'deny',
    index: false,
    maxAge: APP_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || path.extname(req.path)) {
      return next();
    }
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
} else {
  console.warn(`Frontend build not found at ${FRONTEND_DIR}; serving API only`);
}

function errorHandler(err, req, res, next) {
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
}

app.use(errorHandler);

function portalOriginGuard(req, res, next) {
  const origin = req.get('origin');
  if (origin && !isAllowedOrigin(req, origin)) {
    return res.status(403).json({ success: false, message: 'Origin is not allowed' });
  }
  const fetchSite = req.get('sec-fetch-site');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    fetchSite &&
    !['same-origin', 'none'].includes(fetchSite)
  ) {
    return res.status(403).json({ success: false, message: 'Cross-site request blocked' });
  }
  return next();
}

const portalLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    message: 'Terlalu banyak percobaan login. Tunggu 15 menit lalu coba lagi.'
  }
});
const portalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak permintaan. Coba lagi sebentar.' }
});
const portalMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Terlalu banyak perubahan WiFi. Tunggu 15 menit lalu coba lagi.'
  }
});
const portalRevealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Terlalu banyak permintaan password. Tunggu 15 menit lalu coba lagi.'
  }
});

portalApp.use(portalOriginGuard);
portalApp.use(express.json({ limit: '16kb' }));
portalApp.use('/api/customer/login', portalLoginLimiter);
portalApp.use('/api/customer/wifi/:index/password', portalRevealLimiter);
portalApp.use('/api/customer/wifi', portalMutationLimiter);
portalApp.use('/api', portalApiLimiter);
portalApp.use('/api/customer', customerPortalRoutes);
portalApp.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'customer-portal', version: APP_VERSION });
});
portalApp.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

const portalHtmlPath = path.join(FRONTEND_DIR, 'portal.html');
if (fs.existsSync(FRONTEND_DIR)) {
  portalApp.use(express.static(FRONTEND_DIR, {
    dotfiles: 'deny',
    index: false,
    maxAge: APP_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  portalApp.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || path.extname(req.path)) {
      return next();
    }
    if (!fs.existsSync(portalHtmlPath)) {
      return res.status(503).send('Customer portal build is unavailable');
    }
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(portalHtmlPath);
  });
}
portalApp.use(errorHandler);

let server;
let portalServer;

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
      void DeviceService.getDashboardData(false).catch((error) => {
        console.warn(`Dashboard prewarm skipped: ${error.message}`);
      });
      void CustomerService.isAutoGenerationEnabled()
        .then((enabled) => enabled ? DeviceService.getCustomerIdentityDevices() : [])
        .then((devices) => devices.length
          ? CustomerService.syncDevices(devices, { enabled: true })
          : null)
        .catch((error) => {
          console.warn(`Customer ID prewarm skipped: ${error.message}`);
        });
      console.log(`Panel: http://localhost:${PORT}`);
    });
    portalServer = portalApp.listen(PORTAL_PORT, PORTAL_HOST, () => {
      const address = portalServer.address();
      const activePort = typeof address === 'object' && address ? address.port : PORTAL_PORT;
      console.log(`Customer portal: http://localhost:${activePort}`);
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
  if (portalServer) {
    await new Promise((resolve) => portalServer.close(resolve));
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

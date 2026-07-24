import 'dotenv/config';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';

const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (secret) {
    if (process.env.APP_ENV === 'production' && secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters in production');
    }
    return secret;
  }
  if (process.env.APP_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  console.warn('JWT_SECRET not set; using insecure development fallback');
  return 'insecure-development-secret';
})();

function generateTokens(user) {
  const commonOptions = {
    issuer: 'skygenpanel',
    audience: 'skygenpanel-admin'
  };
  const accessToken = jwt.sign(
    { 
      userId: user.id, 
      username: user.username,
      role: user.role,
      tokenVersion: Number(user.token_version || 0)
    }, 
    JWT_SECRET, 
    { ...commonOptions, expiresIn: JWT_EXPIRES_IN }
  );
  
  const refreshToken = jwt.sign(
    { 
      userId: user.id,
      tokenType: 'refresh',
      tokenVersion: Number(user.token_version || 0)
    },
    JWT_SECRET,
    { ...commonOptions, expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );
  
  return { accessToken, refreshToken };
}

function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: 'skygenpanel',
      audience: 'skygenpanel-admin'
    });
    return decoded;
  } catch {
    return null;
  }
}

async function hydrateAuthenticatedUser(decoded) {
  if (!decoded || decoded.tokenType || !Number.isInteger(Number(decoded.userId))) {
    return null;
  }
  const user = await User.findById(decoded.userId);
  if (!user || Number(user.token_version || 0) !== Number(decoded.tokenVersion || 0)) {
    return null;
  }
  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    tokenVersion: Number(user.token_version || 0)
  };
}

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Authentication token required' });
  }
  
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({ 
      message: 'Invalid token', 
      code: 'invalid_token'
    });
  }

  if (decoded.tokenType) {
    return res.status(403).json({
      message: 'Invalid token type',
      code: 'invalid_token'
    });
  }

  try {
    req.user = await hydrateAuthenticatedUser(decoded);
    if (!req.user) {
      return res.status(403).json({
        message: 'Session is no longer valid',
        code: 'invalid_token'
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

async function authenticateTokenOptional(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    req.user = null;
    return next();
  }
  
  const decoded = verifyToken(token);
  try {
    req.user = decoded ? await hydrateAuthenticatedUser(decoded) : null;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    
    if (roles && !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }
    
    next();
  };
}

export {
  generateTokens,
  verifyToken,
  authenticateToken,
  authenticateTokenOptional,
  requireRole
};

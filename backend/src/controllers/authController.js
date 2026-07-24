import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { generateTokens, verifyToken } from '../middleware/auth.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

class AuthController {
  static async login(req, res) {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json(
          createErrorResponse('Username and password are required')
        );
      }
      
      const user = await User.findByUsername(username);
      
      if (!user) {
        return res.status(401).json(
          createErrorResponse('Invalid username or password')
        );
      }
      
      const isMatch = await bcrypt.compare(password, user.password);
      
      if (!isMatch) {
        return res.status(401).json(
          createErrorResponse('Invalid username or password')
        );
      }
      
      const { accessToken, refreshToken } = generateTokens(user);
      
      return res.json(
        createResponse('Login successful', {
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            createdAt: user.created_at,
            updatedAt: user.updated_at
          },
          token: accessToken,
          refreshToken
        })
      );
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json(
        createErrorResponse('Internal server error', error.message)
      );
    }
  }

  static async getSetupStatus(req, res) {
    try {
      const count = await User.count();
      return res.json(
        createResponse('Setup status retrieved', { needsSetup: count === 0 })
      );
    } catch (error) {
      console.error('Setup status error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get setup status', error.message)
      );
    }
  }

  static async setupAdmin(req, res) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json(
          createErrorResponse('Username and password are required')
        );
      }

      const normalizedUsername = String(username).trim();
      if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
        return res.status(400).json(
          createErrorResponse('Username must be between 3 and 64 characters')
        );
      }

      if (String(password).length < 8 || String(password).length > 128) {
        return res.status(400).json(
          createErrorResponse('Password must be between 8 and 128 characters')
        );
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const userId = await User.createInitialAdmin({
        username: normalizedUsername,
        password: hashedPassword
      });
      const user = { id: userId, username: normalizedUsername, role: 'admin' };

      const { accessToken, refreshToken } = generateTokens(user);

      return res.status(201).json(
        createResponse('Admin account created successfully', {
          user: { id: userId, username: normalizedUsername, role: 'admin' },
          token: accessToken,
          refreshToken
        })
      );
    } catch (error) {
      console.error('Setup admin error:', error);
      if (error.code === 'SETUP_COMPLETED') {
        return res.status(409).json(
          createErrorResponse('Setup already completed')
        );
      }
      return res.status(500).json(
        createErrorResponse('Failed to create admin account', error.message)
      );
    }
  }

  static async getCurrentUser(req, res) {
    try {
      const userId = req.user.userId;
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse('User not found')
        );
      }
      
      return res.json(
        createResponse('User retrieved successfully', {
          id: user.id,
          username: user.username,
          role: user.role,
          createdAt: user.created_at,
          updatedAt: user.updated_at
        })
      );
    } catch (error) {
      console.error('Get current user error:', error);
      return res.status(500).json(
        createErrorResponse('Internal server error', error.message)
      );
    }
  }

  static async logout(req, res) {
    return res.json(
      createResponse('Logout successful')
    );
  }

  static async refreshToken(req, res) {
    try {
      const { refreshToken } = req.body;
      
      if (!refreshToken) {
        return res.status(400).json(
          createErrorResponse('Refresh token is required')
        );
      }
      
      const decoded = verifyToken(refreshToken);
      
      if (!decoded) {
        return res.status(403).json(
          createErrorResponse('Invalid refresh token')
        );
      }
      
      if (!decoded.tokenType || decoded.tokenType !== 'refresh') {
        return res.status(403).json(
          createErrorResponse('Invalid token type')
        );
      }
      
      const user = await User.findById(decoded.userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse('User not found')
        );
      }
      
      const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);
      
      return res.json(
        createResponse('Token refreshed successfully', {
          token: accessToken,
          refreshToken: newRefreshToken
        })
      );
    } catch (error) {
      console.error('Refresh token error:', error);
      return res.status(500).json(
        createErrorResponse('Internal server error', error.message)
      );
    }
  }

  static async changePassword(req, res) {
    try {
      const userId = req.user.userId;
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        return res.status(400).json(
          createErrorResponse('Current password and new password are required')
        );
      }

      if (String(newPassword).length < 8 || String(newPassword).length > 128) {
        return res.status(400).json(
          createErrorResponse('New password must be between 8 and 128 characters')
        );
      }
      
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse('User not found')
        );
      }
      
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      
      if (!isMatch) {
        return res.status(401).json(
          createErrorResponse('Current password is incorrect')
        );
      }
      
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await User.updatePassword(userId, hashedPassword);
      
      return res.json(
        createResponse('Password updated successfully')
      );
    } catch (error) {
      console.error('Change password error:', error);
      return res.status(500).json(
        createErrorResponse('Internal server error', error.message)
      );
    }
  }

  static async changeUsername(req, res) {
    try {
      const userId = req.user.userId;
      const { currentUsername, newUsername } = req.body;
      
      if (!currentUsername || !newUsername) {
        return res.status(400).json(
          createErrorResponse('Current username and new username are required')
        );
      }

      const normalizedUsername = String(newUsername).trim();
      if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
        return res.status(400).json(
          createErrorResponse('New username must be between 3 and 64 characters')
        );
      }
      
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse('User not found')
        );
      }
      
      if (user.username !== currentUsername) {
        return res.status(401).json(
          createErrorResponse('Current username is incorrect')
        );
      }
      
      const existingUser = await User.findByUsername(normalizedUsername);
      
      if (existingUser) {
        return res.status(409).json(
          createErrorResponse('Username already taken')
        );
      }
      
      await User.updateUsername(userId, normalizedUsername);
      
      return res.json(
        createResponse('Username updated successfully')
      );
    } catch (error) {
      console.error('Change username error:', error);
      return res.status(500).json(
        createErrorResponse('Internal server error', error.message)
      );
    }
  }
}

export default AuthController;

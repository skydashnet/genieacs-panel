import express from 'express';
import AuthController from '../controllers/authController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/setup-status', AuthController.getSetupStatus);

router.post('/setup', AuthController.setupAdmin);

router.post('/login', AuthController.login);

router.get('/user', authenticateToken, AuthController.getCurrentUser);

router.post('/logout', authenticateToken, AuthController.logout);

router.post('/refresh', AuthController.refreshToken);

router.post('/change-password', authenticateToken, AuthController.changePassword);

router.post('/change-username', authenticateToken, AuthController.changeUsername);

export default router;
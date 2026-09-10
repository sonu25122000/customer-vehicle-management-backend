import { Router } from 'express';
import {
  login,
  logout,
  me,
  updateMaxSessions,
  loginValidators,
  maxSessionsValidators,
} from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/login', loginValidators, login);
router.post('/logout', logout);
router.get('/me', requireAuth, me);
router.patch('/max-sessions', requireAuth, maxSessionsValidators, updateMaxSessions);

export default router;

import { Router } from 'express';
import {
  login,
  logout,
  me,
  changePassword,
  listUsers,
  createUser,
  updateUserRole,
  updateMaxSessions,
  loginValidators,
  changePasswordValidators,
  createUserValidators,
  roleUpdateValidators,
  maxSessionsValidators,
} from '../controllers/authController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   - name: Auth
 *     description: Login and account/session management. There is no public signup — every account is created by an admin.
 */

/**
 * @swagger
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string }
 *               password: { type: string, format: password }
 *               remember: { type: boolean, description: 'Extends the session cookie to 30 days' }
 *     responses:
 *       200:
 *         description: Logged in — sets the `token` cookie
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { admin: { $ref: '#/components/schemas/Admin' } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { description: Invalid username or password, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/login', loginValidators, login);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Log out the current session
 *     security: []
 *     responses:
 *       200: { description: Logged out — clears the `token` cookie }
 */
router.post('/logout', logout);

/**
 * @swagger
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get the signed-in account
 *     responses:
 *       200:
 *         description: Current account
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { admin: { $ref: '#/components/schemas/Admin' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me', requireAuth, me);

/**
 * @swagger
 * /auth/change-password:
 *   patch:
 *     tags: [Auth]
 *     summary: Change the signed-in account's own password
 *     description: On success, every other active session for this account is signed out — only the session making this request stays valid.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string, format: password }
 *               newPassword: { type: string, format: password, minLength: 6 }
 *     responses:
 *       200: { description: Password changed }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { description: Not authenticated, or currentPassword is incorrect, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.patch('/change-password', requireAuth, changePasswordValidators, changePassword);

/**
 * @swagger
 * /auth/max-sessions:
 *   patch:
 *     tags: [Auth]
 *     summary: Set how many devices this account can be logged in on at once
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [maxActiveSessions], properties: { maxActiveSessions: { type: integer, minimum: 1 } } }
 *     responses:
 *       200: { description: Limit updated }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.patch('/max-sessions', requireAuth, maxSessionsValidators, updateMaxSessions);

/**
 * @swagger
 * /auth/users:
 *   get:
 *     tags: [Auth]
 *     summary: List all staff accounts (admin only)
 *     responses:
 *       200:
 *         description: List of accounts
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Admin' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Auth]
 *     summary: Create a staff account (admin only)
 *     description: The only way a new account gets created — there is no public signup. The admin picks the role at creation time (defaults to viewer).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string, minLength: 3, maxLength: 30 }
 *               password: { type: string, format: password, minLength: 6 }
 *               role: { type: string, enum: [viewer, moderator, admin], default: viewer }
 *     responses:
 *       201: { description: Account created }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { description: Username already taken, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/users', requireAuth, requireRole('admin'), listUsers);
router.post('/users', requireAuth, requireRole('admin'), createUserValidators, createUser);

/**
 * @swagger
 * /auth/users/{id}/role:
 *   patch:
 *     tags: [Auth]
 *     summary: Change another account's role (admin only)
 *     description: Refuses to demote the last remaining admin.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [role], properties: { role: { type: string, enum: [viewer, moderator, admin] } } }
 *     responses:
 *       200: { description: Role updated }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.patch('/users/:id/role', requireAuth, requireRole('admin'), roleUpdateValidators, updateUserRole);

export default router;

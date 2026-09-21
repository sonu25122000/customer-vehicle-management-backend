import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, param, validationResult } from 'express-validator';
import Admin from '../models/Admin.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const loginValidators = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

const usernameValidator = body('username')
  .trim()
  .notEmpty()
  .withMessage('Username is required')
  .isLength({ min: 3, max: 30 })
  .withMessage('Username must be 3-30 characters')
  .matches(/^[a-zA-Z0-9_.]+$/)
  .withMessage('Username can only contain letters, numbers, dots and underscores');

const passwordValidator = body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters');

// POST /api/auth/users — admin only. Lets an admin pick the role at creation time (unlike the
// old public signup, which only ever produced viewers).
export const createUserValidators = [
  usernameValidator,
  passwordValidator,
  body('role').optional().isIn(['viewer', 'moderator', 'admin']).withMessage('Invalid role'),
];

export const changePasswordValidators = [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
];

export const roleUpdateValidators = [
  param('id').isMongoId().withMessage('Invalid account'),
  body('role').isIn(['viewer', 'moderator', 'admin']).withMessage('Invalid role'),
];

export const maxSessionsValidators = [
  body('maxActiveSessions').isInt({ min: 1 }).withMessage('Max active sessions must be at least 1'),
];

const DEFAULT_SESSION_MS = Number(process.env.SESSION_MAX_AGE_MS) || 24 * 60 * 60 * 1000; // 1 day
const REMEMBER_SESSION_MS = Number(process.env.SESSION_REMEMBER_MAX_AGE_MS) || 30 * 24 * 60 * 60 * 1000; // 30 days
// Only used as the starting value for a brand-new admin (see ensureAdmin in server.js) —
// after that, each admin's own maxActiveSessions field is what's enforced.
const DEFAULT_MAX_ACTIVE_SESSIONS = Math.max(1, Number(process.env.MAX_ACTIVE_SESSIONS) || 1);

function signToken(admin, sessionId, remember) {
  return jwt.sign(
    { id: admin._id, username: admin.username, sessionId },
    process.env.JWT_SECRET,
    { expiresIn: remember ? process.env.JWT_REMEMBER_EXPIRES_IN || '30d' : process.env.JWT_EXPIRES_IN || '1d' }
  );
}

function cookieOptions(remember) {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    // 'none' is required for the cookie to be sent on cross-site requests (frontend and
    // backend on different domains), which in turn requires secure:true (HTTPS-only) —
    // fine in production since Vercel serves everything over HTTPS. Locally, both run on
    // http://localhost, so 'lax' + non-secure is what actually works there.
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: remember ? REMEMBER_SESSION_MS : DEFAULT_SESSION_MS,
  };
}

// Registers a new active session for this account on login, evicts the oldest sessions beyond
// its device limit, signs the JWT and sets the cookie.
async function issueSession(admin, remember, res) {
  const limit = admin.maxActiveSessions || DEFAULT_MAX_ACTIVE_SESSIONS;
  const sessionId = crypto.randomUUID();
  admin.activeSessions.push({ sessionId, createdAt: new Date() });
  admin.activeSessions.sort((a, b) => a.createdAt - b.createdAt);
  if (admin.activeSessions.length > limit) {
    admin.activeSessions = admin.activeSessions.slice(-limit);
  }
  await admin.save();

  const token = signToken(admin, sessionId, Boolean(remember));
  res.cookie('token', token, cookieOptions(Boolean(remember)));
  return { id: admin._id, username: admin.username, role: admin.role, maxActiveSessions: limit };
}

export const login = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const { username, password, remember } = req.body;
  const admin = await Admin.findOne({ username: username.toLowerCase().trim() });

  if (!admin) {
    return res.status(401).json({ message: 'Invalid username or password' });
  }

  const isMatch = await bcrypt.compare(password, admin.passwordHash);
  if (!isMatch) {
    return res.status(401).json({ message: 'Invalid username or password' });
  }

  const responseAdmin = await issueSession(admin, Boolean(remember), res);
  res.status(200).json({ admin: responseAdmin });
});

// POST /api/auth/users — admin only. There is no public signup: every account is created here,
// by an admin, with the role they choose (defaulting to viewer). Does not log the new account
// in or touch the creating admin's own session.
export const createUser = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const username = req.body.username.toLowerCase().trim();
  const existing = await Admin.findOne({ username });
  if (existing) {
    return res.status(409).json({ message: 'This username is already taken' });
  }

  const passwordHash = await bcrypt.hash(req.body.password, 10);
  const admin = await Admin.create({
    username,
    passwordHash,
    role: req.body.role || 'viewer',
    maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS,
  });

  res.status(201).json({
    data: { id: admin._id, username: admin.username, role: admin.role, createdAt: admin.createdAt },
    message: 'Account created successfully',
  });
});

export const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.token;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      await Admin.findByIdAndUpdate(payload.id, { $pull: { activeSessions: { sessionId: payload.sessionId } } });
    } catch {
      // Token already invalid/expired — nothing to clean up server-side, still clear the cookie.
    }
  }

  res.clearCookie('token', { ...cookieOptions(false), maxAge: undefined });
  res.status(200).json({ message: 'Logged out successfully' });
});

export const me = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.admin.id).select('username role maxActiveSessions activeSessions');
  res.status(200).json({
    admin: {
      id: admin._id,
      username: admin.username,
      role: admin.role,
      maxActiveSessions: admin.maxActiveSessions,
      activeSessionCount: admin.activeSessions.length,
    },
  });
});

// PATCH /api/auth/change-password — the signed-in account changes its own password. Every other
// active session for this account is signed out afterwards (reusing the existing activeSessions
// eviction mechanism), on the assumption that a password change is often a reaction to a
// compromised/shared device elsewhere.
export const changePassword = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const admin = await Admin.findById(req.admin.id);
  const isMatch = await bcrypt.compare(req.body.currentPassword, admin.passwordHash);
  if (!isMatch) {
    return res.status(401).json({ message: 'Current password is incorrect' });
  }

  admin.passwordHash = await bcrypt.hash(req.body.newPassword, 10);
  admin.activeSessions = admin.activeSessions.filter((s) => s.sessionId === req.admin.sessionId);
  await admin.save();

  res.status(200).json({ message: 'Password changed successfully. Other devices have been signed out.' });
});

// GET /api/auth/users — admin only. Backing list for the Users management page.
export const listUsers = asyncHandler(async (_req, res) => {
  const users = await Admin.find().select('username role createdAt').sort({ createdAt: 1 });
  res.status(200).json({ data: users });
});

// PATCH /api/auth/users/:id/role — admin only. Changes an existing account's role.
export const updateUserRole = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const target = await Admin.findById(req.params.id);
  if (!target) {
    return res.status(404).json({ message: 'Account not found' });
  }

  // Guard against locking everyone out of admin-only features by demoting the last admin.
  if (target.role === 'admin' && req.body.role !== 'admin') {
    const otherAdmins = await Admin.countDocuments({ _id: { $ne: target._id }, role: 'admin' });
    if (otherAdmins === 0) {
      return res.status(400).json({ message: 'Cannot change role: at least one admin account must remain' });
    }
  }

  target.role = req.body.role;
  await target.save();

  res.status(200).json({
    data: { id: target._id, username: target.username, role: target.role },
    message: 'Role updated successfully',
  });
});

// PATCH /api/auth/max-sessions — lets the signed-in admin set their own device limit.
export const updateMaxSessions = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const limit = Number(req.body.maxActiveSessions);
  const admin = await Admin.findById(req.admin.id);

  admin.maxActiveSessions = limit;
  // Lowering the limit below the current active count evicts the oldest sessions to match —
  // but never the session making this very request, so changing the setting can't log you
  // yourself out as a side effect.
  if (admin.activeSessions.length > limit) {
    const current = admin.activeSessions.find((s) => s.sessionId === req.admin.sessionId);
    const others = admin.activeSessions
      .filter((s) => s.sessionId !== req.admin.sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, current ? limit - 1 : limit);
    admin.activeSessions = current ? [...others, current] : others;
  }
  await admin.save();

  res.status(200).json({
    maxActiveSessions: admin.maxActiveSessions,
    activeSessionCount: admin.activeSessions.length,
    message: 'Device limit updated successfully',
  });
});

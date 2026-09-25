import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, param, query, validationResult } from 'express-validator';
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

// PATCH /api/auth/users/:id — admin only. Every field is optional so the same endpoint edits
// just a username, just a role, or resets a password.
export const updateUserValidators = [
  param('id').isMongoId().withMessage('Invalid account'),
  body('username')
    .optional()
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage('Username must be 3-30 characters')
    .matches(/^[a-zA-Z0-9_.]+$/)
    .withMessage('Username can only contain letters, numbers, dots and underscores'),
  body('role').optional().isIn(['viewer', 'moderator', 'admin']).withMessage('Invalid role'),
  body('password').optional({ checkFalsy: true }).isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

export const userIdValidators = [param('id').isMongoId().withMessage('Invalid account')];

export const userStatusValidators = [
  param('id').isMongoId().withMessage('Invalid account'),
  body('isActive').isBoolean().withMessage('isActive must be true or false').toBoolean(),
];

export const listUsersValidators = [
  query('status').optional({ checkFalsy: true }).isIn(['active', 'inactive']).withMessage('Invalid status filter'),
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

  if (admin.isActive === false) {
    return res.status(403).json({ message: 'This account has been deactivated. Contact an administrator.' });
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

// "Active" includes accounts that predate the isActive field (missing => active).
const ACTIVE_FILTER = { isActive: { $ne: false } };
const INACTIVE_FILTER = { isActive: false };

function publicUser(u) {
  return {
    _id: u._id,
    username: u.username,
    role: u.role,
    isActive: u.isActive !== false,
    createdAt: u.createdAt,
    deactivatedAt: u.deactivatedAt,
  };
}

// True when demoting/deactivating `target` would leave no active admin — guards against locking
// everyone out of admin-only features.
async function isLastActiveAdmin(target) {
  if (target.role !== 'admin' || target.isActive === false) return false;
  const others = await Admin.countDocuments({ _id: { $ne: target._id }, role: 'admin', ...ACTIVE_FILTER });
  return others === 0;
}

// GET /api/auth/users?status=active|inactive — admin only. Backing list for the Users page tabs
// (defaults to active); counts for both tabs are returned so the tab badges stay accurate.
export const listUsers = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const status = req.query.status === 'inactive' ? 'inactive' : 'active';
  const [users, active, inactive] = await Promise.all([
    Admin.find(status === 'inactive' ? INACTIVE_FILTER : ACTIVE_FILTER)
      .select('username role isActive createdAt deactivatedAt')
      .sort({ createdAt: 1 }),
    Admin.countDocuments(ACTIVE_FILTER),
    Admin.countDocuments(INACTIVE_FILTER),
  ]);
  res.status(200).json({ data: users.map(publicUser), counts: { active, inactive } });
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
  if (String(target._id) === String(req.admin.id)) {
    return res.status(400).json({ message: "You can't change your own role" });
  }

  if (req.body.role !== 'admin' && (await isLastActiveAdmin(target))) {
    return res.status(400).json({ message: 'Cannot change role: at least one admin account must remain' });
  }

  target.role = req.body.role;
  await target.save();

  res.status(200).json({
    data: { id: target._id, username: target.username, role: target.role },
    message: 'Role updated successfully',
  });
});

// PATCH /api/auth/users/:id — admin only. Edits username / role and can reset the password.
// A password reset for another account signs it out everywhere so it takes effect at once.
export const updateUser = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const target = await Admin.findById(req.params.id);
  if (!target) {
    return res.status(404).json({ message: 'Account not found' });
  }

  const isSelf = String(target._id) === String(req.admin.id);
  const { username, role, password } = req.body;

  if (username !== undefined) {
    const normalized = username.toLowerCase().trim();
    if (normalized !== target.username) {
      const clash = await Admin.findOne({ username: normalized, _id: { $ne: target._id } });
      if (clash) return res.status(409).json({ message: 'This username is already taken' });
      target.username = normalized;
    }
  }

  if (role !== undefined && role !== target.role) {
    if (isSelf) return res.status(400).json({ message: "You can't change your own role" });
    if (role !== 'admin' && (await isLastActiveAdmin(target))) {
      return res.status(400).json({ message: 'Cannot change role: at least one admin account must remain' });
    }
    target.role = role;
  }

  if (password) {
    target.passwordHash = await bcrypt.hash(password, 10);
    if (!isSelf) target.activeSessions = [];
  }

  await target.save();
  res.status(200).json({ data: publicUser(target), message: 'Account updated successfully' });
});

// Shared by DELETE /users/:id (soft delete) and PATCH /users/:id/status (disable / re-enable).
async function setUserActive(req, res, isActive) {
  const target = await Admin.findById(req.params.id);
  if (!target) {
    return res.status(404).json({ message: 'Account not found' });
  }

  if (!isActive) {
    if (String(target._id) === String(req.admin.id)) {
      return res.status(400).json({ message: "You can't deactivate your own account" });
    }
    if (await isLastActiveAdmin(target)) {
      return res.status(400).json({ message: 'Cannot deactivate: at least one active admin account must remain' });
    }
    target.isActive = false;
    target.deactivatedAt = new Date();
    target.activeSessions = []; // sign them out on every device straight away
  } else {
    target.isActive = true;
    target.deactivatedAt = undefined;
  }

  await target.save();
  res.status(200).json({
    data: publicUser(target),
    message: isActive ? 'Account reactivated successfully' : 'Account deactivated successfully',
  });
}

// DELETE /api/auth/users/:id — admin only. Soft delete: the account is deactivated (moves to the
// Inactive tab), never removed from the database, and can be reactivated later.
export const deleteUser = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }
  return setUserActive(req, res, false);
});

// PATCH /api/auth/users/:id/status — admin only. { isActive: false } disables, { isActive: true }
// reactivates.
export const updateUserStatus = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }
  return setUserActive(req, res, req.body.isActive);
});

// GET /api/auth/max-sessions — the signed-in account's device limit and how many sessions are
// currently active against it. API/Swagger only; the frontend reads the same values from /auth/me.
export const getMaxSessions = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.admin.id).select('maxActiveSessions activeSessions');
  res.status(200).json({
    maxActiveSessions: admin.maxActiveSessions || DEFAULT_MAX_ACTIVE_SESSIONS,
    activeSessionCount: admin.activeSessions.length,
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

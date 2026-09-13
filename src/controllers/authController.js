import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import Admin from '../models/Admin.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const loginValidators = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required'),
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

  // Register this login as a new active session, then evict the oldest ones beyond this
  // account's own device limit — that's what signs other devices out.
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
  res.status(200).json({ admin: { id: admin._id, username: admin.username, maxActiveSessions: limit } });
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
  const admin = await Admin.findById(req.admin.id).select('username maxActiveSessions activeSessions');
  res.status(200).json({
    admin: {
      id: admin._id,
      username: admin.username,
      maxActiveSessions: admin.maxActiveSessions,
      activeSessionCount: admin.activeSessions.length,
    },
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

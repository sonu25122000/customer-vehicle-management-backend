import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const requireAuth = asyncHandler(async (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired session' });
  }

  const admin = await Admin.findById(payload.id).select('username role activeSessions maxActiveSessions');
  if (!admin) {
    return res.status(401).json({ message: 'Invalid or expired session' });
  }

  // Self-heals drift between activeSessions and maxActiveSessions — e.g. the limit was
  // lowered directly in the database rather than through the login/update-limit flow, which
  // are the only two places eviction otherwise happens. Whichever session hits this check
  // first prunes the list down to the newest maxActiveSessions entries for everyone.
  const limit = admin.maxActiveSessions || 1;
  if (admin.activeSessions.length > limit) {
    admin.activeSessions.sort((a, b) => a.createdAt - b.createdAt);
    admin.activeSessions = admin.activeSessions.slice(-limit);
    await admin.save();
  }

  // This device's session was either logged out elsewhere, or evicted (above, or by a newer
  // login / a lowered device limit reached before this request).
  const isActive = admin.activeSessions.some((s) => s.sessionId === payload.sessionId);
  if (!isActive) {
    return res
      .status(401)
      .json({ message: 'You have been signed out. This device is no longer an active session for this account.' });
  }

  // Role is read fresh from the DB above (never from the JWT payload) so a promotion/demotion
  // takes effect on this account's very next request instead of waiting for the token to expire.
  req.admin = { id: admin._id, username: admin.username, role: admin.role, sessionId: payload.sessionId };
  next();
});

// The single place role-based authorization happens — every mutating/admin-only route composes
// this after requireAuth rather than re-implementing a role check inline in its controller.
export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.admin?.role)) {
    return res.status(403).json({ message: 'You do not have permission to perform this action' });
  }
  next();
};

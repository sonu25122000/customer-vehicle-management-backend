import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const adminSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    // viewer: read-only. moderator: can create/edit/delete records. admin: everything moderator
    // can do, plus managing Coupons & Offers and other accounts' roles. There is no public signup —
    // every account is created by an admin (POST /api/auth/users) with the role they choose; roles
    // can be changed later via PATCH /api/auth/users/:id/role.
    role: {
      type: String,
      enum: ['viewer', 'moderator', 'admin'],
      default: 'viewer',
    },
    // Every login adds an entry here. A JWT is only valid while its embedded sessionId is
    // still present in this list — logging out removes it, and exceeding maxActiveSessions
    // evicts the oldest entries, signing those devices out.
    activeSessions: {
      type: [sessionSchema],
      default: [],
    },
    // Per-account device limit — each admin can have their own, ready for when there's
    // more than one admin. Defaults to MAX_ACTIVE_SESSIONS from .env at creation time.
    maxActiveSessions: {
      type: Number,
      default: 1,
      min: 1,
    },
  },
  { timestamps: true }
);

export default mongoose.model('Admin', adminSchema);

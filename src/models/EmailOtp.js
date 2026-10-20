import mongoose from 'mongoose';

export const EMAIL_OTP_PURPOSES = ['signup', 'change-email'];

// The latest email verification code for one address and purpose (utils/emailOtp.js): proving a guest
// owns the email they sign up with ('signup'), or the new one they switch to ('change-email', tied to
// that customer). Only a hash of the code is kept. One row per email + purpose + customer; asking again
// replaces the code. MongoDB deletes rows a couple of hours after their last change (TTL index).
const emailOtpSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    purpose: { type: String, enum: EMAIL_OTP_PURPOSES, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    codeHash: { type: String },
    expiresAt: { type: Date },
    // Wrong codes entered for the current code.
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date },
    // Codes sent in the current hour-long window (windowStartedAt), to cap how many can be requested.
    sendCount: { type: Number, default: 0 },
    windowStartedAt: { type: Date },
  },
  { timestamps: true }
);

emailOtpSchema.index({ email: 1, purpose: 1, customer: 1 }, { unique: true });
emailOtpSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 2 * 60 * 60 });

export default mongoose.model('EmailOtp', emailOtpSchema);

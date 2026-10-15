import mongoose from 'mongoose';

export const OTP_PURPOSES = ['start', 'end'];

// One row per OTP an admin generates for a trip. The customer enters it on the customer site to start
// (purpose 'start') or end (purpose 'end') their trip — see utils/tripOtp.js. Admins can start or end a
// trip from the admin portal without one.
//
// The code is kept readable (not hashed) because admins have to be able to see it again to share it;
// it is never returned by any customer-site endpoint. Rows are never deleted, so the full history of
// which codes were issued for a trip is kept.
const tripOtpSchema = new mongoose.Schema(
  {
    trip: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trip',
      required: true,
    },
    purpose: {
      type: String,
      enum: OTP_PURPOSES,
      required: true,
    },
    code: {
      type: String,
      required: true,
    },
    // true while the code can still be used. Cleared when it is used, replaced by a newer code,
    // expires, runs out of attempts, or the trip moves past the step it was for.
    active: {
      type: Boolean,
      default: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    usedAt: { type: Date },
    // Admin username that generated it.
    generatedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

// No two live OTPs anywhere share a code, so a code can never be accepted for the wrong trip.
tripOtpSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { active: true } });
tripOtpSchema.index({ trip: 1, purpose: 1, active: 1 });
tripOtpSchema.index({ active: 1, expiresAt: 1 });

export default mongoose.model('TripOtp', tripOtpSchema);

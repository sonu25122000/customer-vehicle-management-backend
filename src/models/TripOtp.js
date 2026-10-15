import mongoose from 'mongoose';

export const OTP_PURPOSES = ['start', 'end'];

// A trip's start (purpose 'start') and end (purpose 'end') OTP, created with the trip — see
// utils/tripOtp.js. The customer enters them on the customer site to start / end their trip; admins can
// start or end a trip from the admin portal without one.
//
// The code is kept readable (not hashed) because admins have to be able to see it to share it; it is
// never returned by any customer-site endpoint. Rows are never deleted.
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
    // true while the code can still be used. Cleared when it is used, or the trip moves past the step
    // it was for (started / completed / cancelled). Codes don't expire.
    active: {
      type: Boolean,
      default: true,
    },
    // Only set on codes issued before codes became static (they used to expire). Ignored now.
    expiresAt: { type: Date },
    // Wrong guesses, for the record — they don't lock the code.
    attempts: {
      type: Number,
      default: 0,
    },
    usedAt: { type: Date },
    // Who created it: an admin username, or 'system' for codes created automatically with the trip.
    generatedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

// No two live OTPs anywhere share a code, so a code can never be accepted for the wrong trip.
tripOtpSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { active: true } });
tripOtpSchema.index({ trip: 1, purpose: 1, active: 1 });

export default mongoose.model('TripOtp', tripOtpSchema);

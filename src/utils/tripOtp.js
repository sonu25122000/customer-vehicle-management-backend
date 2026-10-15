import crypto from 'crypto';
import TripOtp from '../models/TripOtp.js';

// Trip start/end OTPs. Every trip gets two static codes the moment it's created — one to start it and
// one to end it — that only admins can see (admin portal, trip details). The team shares them with the
// customer, who enters them on the customer site to start / end the trip. Admins never need one
// themselves: changing the status in the admin portal starts or ends the trip directly.
//
// The codes don't expire and don't change. Each one stops working once it's no longer needed: the
// start code when the trip starts, both codes when the trip is completed or cancelled.
//
// 6 digits: the same length people already know from bank/UPI OTPs. Guessing is kept impractical by the
// customer having to be logged in as the trip's own customer, plus the per-client rate limit on the
// start/end endpoints (routes/portalRoutes.js).
export const OTP_LENGTH = 6;

// Which codes a trip in each status still needs.
const PURPOSES_BY_STATUS = {
  'Yet to Start': ['start', 'end'],
  'On Trip': ['end'],
};

function randomCode() {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

// Codes that are easy to guess or mistype: all one digit (111111) or a straight run (123456, 654321).
function isWeak(code) {
  if (/^(\d)\1+$/.test(code)) return true;
  const digits = code.split('').map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

// Creates the code for one step of a trip, unless the trip already has a live one for that step. The
// start and end codes of a trip are always different, and no two live codes anywhere are the same (the
// partial unique index on TripOtp.code is the final guarantee for that).
async function issueTripOtp(tripId, purpose, generatedBy) {
  const live = await TripOtp.findOne({ trip: tripId, purpose, active: true });
  if (live) return live;
  const usedForTrip = new Set(await TripOtp.distinct('code', { trip: tripId }));

  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomCode();
    if (isWeak(code) || usedForTrip.has(code)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      return await TripOtp.create({ trip: tripId, purpose, code, generatedBy });
    } catch (err) {
      if (err?.code === 11000) continue; // another trip holds this code right now — pick another
      throw err;
    }
  }
  throw new Error('Could not generate a unique OTP, please try again');
}

// Makes sure a trip has the codes its status needs: start + end while Yet to Start, end while On Trip.
// Called when a trip is created, and when an admin opens a trip (so trips created before static codes
// existed get theirs too).
export async function ensureTripOtps(trip, generatedBy = 'system') {
  for (const purpose of PURPOSES_BY_STATUS[trip.status] || []) {
    // Sequential: the second code must differ from the first.
    // eslint-disable-next-line no-await-in-loop
    await issueTripOtp(trip._id, purpose, generatedBy);
  }
}

// The live start/end codes of a trip, for the admin portal only (never sent to the customer site).
export async function activeTripOtps(tripId) {
  const rows = await TripOtp.find({ trip: tripId, active: true }).sort({ createdAt: 1 }).lean();
  const result = { start: null, end: null };
  for (const row of rows) {
    if (!result[row.purpose]) result[row.purpose] = { code: row.code, generatedAt: row.createdAt };
  }
  return result;
}

// Retires the codes for these steps — e.g. the start code once the trip has started, both once it's
// completed or cancelled.
export function retireTripOtps(tripId, purposes) {
  return TripOtp.updateMany({ trip: tripId, purpose: { $in: purposes }, active: true }, { $set: { active: false } });
}

function sameCode(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Checks the code the customer entered and, if it's right, uses it up (atomically, so the same code
// can't be used twice). Returns { ok: true } or { ok: false, message }.
export async function consumeTripOtp(tripId, purpose, code) {
  const otp = await TripOtp.findOne({ trip: tripId, purpose, active: true });
  if (!otp) {
    return { ok: false, message: 'There is no OTP for this step of your trip. Please contact our team.' };
  }
  if (!sameCode(otp.code, code)) {
    await TripOtp.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    return { ok: false, message: 'Incorrect OTP. Please check the code our team shared and try again.' };
  }
  const used = await TripOtp.findOneAndUpdate({ _id: otp._id, active: true }, { $set: { active: false, usedAt: new Date() } });
  if (!used) {
    return { ok: false, message: 'This OTP has already been used.' };
  }
  return { ok: true };
}

import crypto from 'crypto';
import TripOtp from '../models/TripOtp.js';

// Trip start/end OTPs. An admin generates one in the admin portal and shares it with the customer
// (in person, by phone or WhatsApp); the customer enters it on the customer site to start or end the
// trip. Admins themselves never need one.
//
// 6 digits rather than 4: the same length people already know from bank/UPI OTPs, and a million
// possible codes (vs ten thousand) keeps guessing impractical alongside the attempt limit below, and
// leaves plenty of room for every live code to be different from every other.
export const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = Number(process.env.TRIP_OTP_TTL_MINUTES) || 30;
export const OTP_MAX_ATTEMPTS = 5;

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

function expireStale(now = new Date()) {
  return TripOtp.updateMany({ active: true, expiresAt: { $lt: now } }, { $set: { active: false } });
}

// Issues a fresh OTP for one step of a trip, replacing any code still live for that step. Every new
// code is different from every code this trip has ever had (so a regenerated code is always a new
// one, and the start and end codes never match), and from every other trip's live code — the partial
// unique index on TripOtp.code is the final guarantee for the latter.
export async function issueTripOtp(tripId, purpose, generatedBy = '') {
  const now = new Date();
  await expireStale(now);
  const usedForTrip = new Set(await TripOtp.distinct('code', { trip: tripId }));
  await TripOtp.updateMany({ trip: tripId, purpose, active: true }, { $set: { active: false } });

  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomCode();
    if (isWeak(code) || usedForTrip.has(code)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      return await TripOtp.create({
        trip: tripId,
        purpose,
        code,
        expiresAt: new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000),
        generatedBy,
      });
    } catch (err) {
      if (err?.code === 11000) continue; // another trip holds this code right now — pick another
      throw err;
    }
  }
  throw new Error('Could not generate a unique OTP, please try again');
}

// The live start/end OTPs for a trip, for the admin portal only.
export async function activeTripOtps(tripId) {
  await expireStale();
  const rows = await TripOtp.find({ trip: tripId, active: true }).sort({ createdAt: -1 }).lean();
  const result = { start: null, end: null };
  for (const row of rows) {
    if (!result[row.purpose]) {
      result[row.purpose] = {
        code: row.code,
        expiresAt: row.expiresAt,
        generatedAt: row.createdAt,
        generatedBy: row.generatedBy,
        attemptsLeft: Math.max(OTP_MAX_ATTEMPTS - row.attempts, 0),
      };
    }
  }
  return result;
}

// Retires any live OTPs for these steps of a trip — e.g. once an admin has started the trip from the
// admin portal, its start OTP must not work any more.
export function retireTripOtps(tripId, purposes) {
  return TripOtp.updateMany({ trip: tripId, purpose: { $in: purposes }, active: true }, { $set: { active: false } });
}

function sameCode(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Checks a code the customer entered and, if it's right, uses it up (atomically, so the same code
// can't be used twice). Wrong guesses count against the code; after OTP_MAX_ATTEMPTS it stops
// working and the admin has to generate a new one.
// Returns { ok: true } or { ok: false, message }.
export async function consumeTripOtp(tripId, purpose, code) {
  const now = new Date();
  const otp = await TripOtp.findOne({ trip: tripId, purpose, active: true });
  if (!otp || otp.expiresAt < now) {
    if (otp) await TripOtp.updateOne({ _id: otp._id }, { $set: { active: false } });
    return { ok: false, message: 'There is no valid OTP for this trip right now. Please ask our team to share a new one.' };
  }

  if (!sameCode(otp.code, code)) {
    const updated = await TripOtp.findOneAndUpdate({ _id: otp._id, active: true }, { $inc: { attempts: 1 } }, { new: true });
    const left = OTP_MAX_ATTEMPTS - (updated?.attempts ?? OTP_MAX_ATTEMPTS);
    if (left <= 0) {
      await TripOtp.updateOne({ _id: otp._id }, { $set: { active: false } });
      return { ok: false, message: 'Too many incorrect attempts. Please ask our team to share a new OTP.' };
    }
    return { ok: false, message: `Incorrect OTP. ${left} attempt${left === 1 ? '' : 's'} left.` };
  }

  const used = await TripOtp.findOneAndUpdate({ _id: otp._id, active: true }, { $set: { active: false, usedAt: now } });
  if (!used) {
    return { ok: false, message: 'This OTP has already been used. Please ask our team to share a new one.' };
  }
  return { ok: true };
}

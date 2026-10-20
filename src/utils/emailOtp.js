import crypto from 'node:crypto';
import EmailOtp from '../models/EmailOtp.js';
import { sendEmail } from './email.js';
import { emailCodeEmail } from './emailTemplates.js';

// Email verification codes — proving a guest owns an email address before it's put on an account
// (signup, or changing the email on their profile). A 6-digit code is emailed; it's valid for
// EMAIL_OTP_VALID_MINUTES, works once, and stops working after MAX_ATTEMPTS wrong tries. A new code can
// be asked for after RESEND_MS, at most MAX_SENDS_PER_HOUR times an hour per address. Only an HMAC of the
// code is stored, keyed to its address, purpose and customer, so a code can't be used anywhere else.

export const EMAIL_OTP_LENGTH = 6;
export const EMAIL_OTP_VALID_MINUTES = 10;
const RESEND_MS = 30 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60 * 1000;

export class EmailOtpError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Sends an EmailOtpError as the response; returns false for any other error (the caller rethrows it).
export function respondWithEmailOtpError(err, res) {
  if (!(err instanceof EmailOtpError)) return false;
  res.status(err.status).json({ message: err.message, code: err.code, ...err.extra });
  return true;
}

function keyFor(email, purpose, customerId) {
  return { email: email.toLowerCase(), purpose, customer: customerId || null };
}

function hashCode(code, { email, purpose, customer }) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'email-otp')
    .update(`${purpose}:${customer || ''}:${email}:${code}`)
    .digest('hex');
}

// Emails a new code to `email`. Resolves to { expiresAt, resendAt }. Throws EmailOtpError when asked too
// soon / too often, or when the email couldn't be sent.
export async function sendEmailOtp({ email, purpose, customerId, name }) {
  const key = keyFor(email, purpose, customerId);
  const now = new Date();
  const row = await EmailOtp.findOne(key);

  if (row?.lastSentAt && now - row.lastSentAt < RESEND_MS) {
    const retryAfter = Math.ceil((RESEND_MS - (now - row.lastSentAt)) / 1000);
    throw new EmailOtpError(429, `Please wait ${retryAfter} seconds before asking for a new code.`, 'EMAIL_OTP_COOLDOWN', { retryAfter });
  }
  const newWindow = !row?.windowStartedAt || now - row.windowStartedAt > HOUR_MS;
  const sendCount = newWindow ? 0 : row.sendCount || 0;
  if (sendCount >= MAX_SENDS_PER_HOUR) {
    throw new EmailOtpError(429, 'Too many codes requested for this email. Please try again in an hour.', 'EMAIL_OTP_LIMIT');
  }

  const code = String(crypto.randomInt(0, 10 ** EMAIL_OTP_LENGTH)).padStart(EMAIL_OTP_LENGTH, '0');
  const expiresAt = new Date(now.getTime() + EMAIL_OTP_VALID_MINUTES * 60 * 1000);
  const previous = row ? row.toObject() : null;
  await EmailOtp.updateOne(
    key,
    {
      $set: {
        codeHash: hashCode(code, key),
        expiresAt,
        attempts: 0,
        lastSentAt: now,
        sendCount: sendCount + 1,
        windowStartedAt: newWindow ? now : row.windowStartedAt,
      },
    },
    { upsert: true }
  );

  let sent = false;
  try {
    sent = await sendEmail({ to: key.email, ...emailCodeEmail({ code, purpose, name, validMinutes: EMAIL_OTP_VALID_MINUTES }) });
  } catch (err) {
    console.error(`[email] Verification code to ${key.email} failed: ${err.message}`);
  }
  // In production a code that wasn't delivered is useless — put things back so they can try again.
  // (Locally without email set up, the code is printed in the server log instead.)
  if (!sent && process.env.NODE_ENV === 'production') {
    if (previous) await EmailOtp.replaceOne(key, previous);
    else await EmailOtp.deleteOne(key);
    throw new EmailOtpError(503, "We couldn't send the code right now. Please try again in a minute.", 'EMAIL_OTP_SEND_FAILED');
  }
  return { expiresAt, resendAt: new Date(now.getTime() + RESEND_MS) };
}

// Checks `code` for this address and purpose and uses it up. Throws EmailOtpError when it's wrong,
// expired or locked after too many wrong tries.
export async function verifyEmailOtp({ email, purpose, customerId, code }) {
  const key = keyFor(email, purpose, customerId);
  const row = await EmailOtp.findOne(key);
  if (!row?.codeHash || !row.expiresAt || row.expiresAt < new Date()) {
    throw new EmailOtpError(400, 'This code has expired. Please ask for a new one.', 'EMAIL_OTP_EXPIRED');
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new EmailOtpError(429, 'Too many wrong codes. Please ask for a new one.', 'EMAIL_OTP_LOCKED');
  }

  const expected = Buffer.from(row.codeHash, 'hex');
  const actual = Buffer.from(hashCode(String(code || ''), key), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    const updated = await EmailOtp.findOneAndUpdate({ _id: row._id }, { $inc: { attempts: 1 } }, { new: true });
    const left = MAX_ATTEMPTS - (updated?.attempts ?? MAX_ATTEMPTS);
    if (left <= 0) throw new EmailOtpError(429, 'Too many wrong codes. Please ask for a new one.', 'EMAIL_OTP_LOCKED');
    throw new EmailOtpError(400, `That code isn't right. ${left} attempt${left === 1 ? '' : 's'} left.`, 'EMAIL_OTP_INVALID', { attemptsLeft: left });
  }

  // Use it up — only once, even if two requests arrive together. The hour's send count is kept.
  const used = await EmailOtp.updateOne(
    { _id: row._id, codeHash: row.codeHash },
    { $unset: { codeHash: 1, expiresAt: 1 }, $set: { attempts: 0 } }
  );
  if (!used.modifiedCount) {
    throw new EmailOtpError(400, 'This code has expired. Please ask for a new one.', 'EMAIL_OTP_EXPIRED');
  }
}

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import Customer from '../models/Customer.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { CUSTOMER_COOKIE } from '../middleware/customerAuth.js';
import { recordCustomerHistory } from '../utils/customerHistory.js';
import crypto from 'node:crypto';
import PasswordReset from '../models/PasswordReset.js';
import { sendEmail } from '../utils/email.js';
import { passwordResetEmail, siteUrl } from '../utils/emailTemplates.js';

// Customer-site sessions last as long as the admin portal's "remember me" sessions.
const SESSION_MS = Number(process.env.SESSION_REMEMBER_MAX_AGE_MS) || 30 * 24 * 60 * 60 * 1000;

const mobileValidator = body('mobile')
  .trim()
  .notEmpty()
  .withMessage('Mobile number is required')
  .matches(/^[0-9]{10}$/)
  .withMessage('Enter a valid 10-digit mobile number');

// Email is required at signup (the profile page can still change it later).
export const signupValidators = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ max: 50 })
    .withMessage('Name cannot exceed 50 characters'),
  mobileValidator,
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isLength({ max: 254 })
    .withMessage('Email is too long')
    .isEmail()
    .withMessage('Enter a valid email address')
    .normalizeEmail({ gmail_remove_dots: false }),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

export const loginValidators = [mobileValidator, body('password').notEmpty().withMessage('Password is required')];

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

function cookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: SESSION_MS,
  };
}

function issueSession(customer, res) {
  const token = jwt.sign({ cid: customer._id, kind: 'customer' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_REMEMBER_EXPIRES_IN || '30d',
  });
  res.cookie(CUSTOMER_COOKIE, token, cookieOptions());
}

// The only customer fields the customer site ever receives.
export function publicCustomer(c) {
  return {
    _id: c._id,
    name: c.name,
    mobile1: c.mobile1,
    email: c.email || '',
    profileVerified: c.profileVerified,
    rating: c.rating,
    createdBy: c.createdBy,
    mustChangePassword: Boolean(c.mustChangePassword),
    // Changes whenever a new picture is uploaded, so the site can cache-bust its <img> URL.
    photoVersion: c.profilePhoto?.s3Key && c.profilePhoto.updatedAt ? new Date(c.profilePhoto.updatedAt).getTime() : null,
    createdAt: c.createdAt,
  };
}

// POST /api/portal/auth/signup
// A brand-new mobile number creates a customer with createdBy:'customer'. A mobile number an admin
// already added (no password yet) is claimed instead: the existing record gets a password, keeps
// createdBy:'admin', and its trips show up for the customer straight away.
export const signup = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { name, mobile, email, password } = req.body;
  const existing = await Customer.findOne({ mobile1: mobile, isDeleted: false }).select('+passwordHash');
  if (existing?.passwordHash) {
    return res.status(409).json({ message: 'An account with this mobile number already exists. Please log in.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let customer;
  if (existing) {
    const before = existing.toObject();
    existing.passwordHash = passwordHash;
    existing.mustChangePassword = false;
    if (email && !existing.email) existing.email = email;
    await existing.save();
    await recordCustomerHistory(before, existing, 'customer', existing.name);
    customer = existing;
  } else {
    customer = await Customer.create({
      name,
      mobile1: mobile,
      email: email || '',
      passwordHash,
      createdBy: 'customer',
      profileVerified: 'Pending',
    });
  }

  issueSession(customer, res);
  res.status(201).json({ customer: publicCustomer(customer), message: 'Account created successfully' });
});

// POST /api/portal/auth/login
export const login = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const customer = await Customer.findOne({ mobile1: req.body.mobile, isDeleted: false }).select('+passwordHash');
  if (customer && !customer.passwordHash) {
    return res.status(401).json({ message: 'Please sign up with this mobile number to set your password first' });
  }
  if (!customer || !(await bcrypt.compare(req.body.password, customer.passwordHash))) {
    return res.status(401).json({ message: 'Invalid mobile number or password' });
  }

  issueSession(customer, res);
  res.status(200).json({ customer: publicCustomer(customer) });
});

// POST /api/portal/auth/logout
export const logout = asyncHandler(async (_req, res) => {
  res.clearCookie(CUSTOMER_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(200).json({ message: 'Logged out successfully' });
});

// GET /api/portal/auth/me
export const me = asyncHandler(async (req, res) => {
  res.status(200).json({ customer: publicCustomer(req.customer) });
});

export const changePasswordValidators = [
  body('currentPassword').notEmpty().withMessage('Enter your current password'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
];

// POST /api/portal/auth/change-password — always allowed for a signed-in customer, and the only thing
// a customer can do (besides logging out) while mustChangePassword is set, i.e. right after logging in
// with the password an admin created or reset for them.
export const changePassword = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { currentPassword, newPassword } = req.body;
  const customer = await Customer.findOne({ _id: req.customer._id, isDeleted: false }).select('+passwordHash');
  if (!customer?.passwordHash || !(await bcrypt.compare(currentPassword, customer.passwordHash))) {
    return res.status(400).json({ message: 'Your current password is incorrect' });
  }
  if (await bcrypt.compare(newPassword, customer.passwordHash)) {
    return res.status(400).json({ message: 'Choose a new password that is different from the current one' });
  }

  customer.passwordHash = await bcrypt.hash(newPassword, 10);
  customer.mustChangePassword = false;
  await customer.save();
  await recordCustomerHistory(customer, customer, 'customer', customer.name, [
    { field: 'password', from: '', to: 'Changed by guest' },
  ]);

  res.status(200).json({ customer: publicCustomer(customer), message: 'Password updated successfully' });
});

// ---------- Forgot password (email link) ----------

const RESET_VALID_MINUTES = 30;
// At most this many reset emails per account per hour, however often the form is sent.
const RESET_EMAILS_PER_HOUR = 3;
// The same answer whether or not an account matched, so the form can't be used to find out who has one.
const RESET_SENT_MESSAGE = "If that matches an account with an email address, we've sent it a link to reset your password.";
const RESET_INVALID = { code: 'RESET_LINK_INVALID', message: 'This reset link is invalid or has expired. Please ask for a new one.' };

const hashResetToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Makes the customer's unused reset links stop working (they're cleaned up by the TTL index later).
function expireOpenResetLinks(customerId) {
  const now = new Date();
  return PasswordReset.updateMany({ customer: customerId, usedAt: null, expiresAt: { $gt: now } }, { $set: { expiresAt: now } });
}

export const forgotPasswordValidators = [
  body('identifier')
    .trim()
    .notEmpty()
    .withMessage('Enter your mobile number or email')
    .isLength({ max: 254 })
    .withMessage('Enter your mobile number or email')
    .custom((value) => /^[0-9]{10}$/.test(value) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    .withMessage('Enter your 10-digit mobile number or your email address')
    // Keep what was typed, then normalise an email the way signup stores it (lowercase; Gmail "+tag" removed).
    .customSanitizer((value, { req }) => {
      req.identifierTyped = value.toLowerCase();
      return value;
    })
    .if((value) => value.includes('@'))
    .normalizeEmail({ gmail_remove_dots: false }),
];

// POST /api/portal/auth/forgot-password { identifier: mobile number or email } — emails a one-time link
// (valid RESET_VALID_MINUTES) to set a new password. A mobile number finds that account; an email finds
// the accounts that use it (each gets its own link). Accounts without an email can't use this — they
// contact the team, who can set a temporary password from the admin portal.
export const forgotPassword = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { identifier } = req.body;
  const filter = /^[0-9]{10}$/.test(identifier)
    ? { mobile1: identifier, email: { $nin: ['', null] } }
    : { email: { $in: [...new Set([identifier, req.identifierTyped])] } };
  const customers = await Customer.find({ ...filter, isDeleted: false }, 'name mobile1 email').limit(3);

  for (const customer of customers) {
    const recent = await PasswordReset.countDocuments({ customer: customer._id, createdAt: { $gt: new Date(Date.now() - 60 * 60 * 1000) } });
    if (recent >= RESET_EMAILS_PER_HOUR) continue;

    const token = crypto.randomBytes(32).toString('hex');
    // A new link replaces any earlier unused ones — they're expired, not deleted, so they still count
    // towards RESET_EMAILS_PER_HOUR.
    await expireOpenResetLinks(customer._id);
    await PasswordReset.create({
      customer: customer._id,
      tokenHash: hashResetToken(token),
      email: customer.email,
      expiresAt: new Date(Date.now() + RESET_VALID_MINUTES * 60 * 1000),
    });
    const link = `${siteUrl()}/reset-password?token=${token}`;
    try {
      await sendEmail({ to: customer.email, ...passwordResetEmail({ name: customer.name, mobile: customer.mobile1, link, validMinutes: RESET_VALID_MINUTES }) });
    } catch (err) {
      console.error(`[email] Password reset email to ${customer.email} failed: ${err.message}`);
    }
  }

  res.status(200).json({ message: RESET_SENT_MESSAGE });
});

const resetTokenValidator = body('token')
  .trim()
  .matches(/^[a-f0-9]{64}$/)
  .withMessage(RESET_INVALID.message);

export const checkResetValidators = [resetTokenValidator];
export const resetPasswordValidators = [resetTokenValidator, body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')];

// POST /api/portal/auth/reset-password/check { token } — whether a reset link still works, so the page
// can say so before the guest types a new password. Doesn't use the link up.
export const checkResetToken = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(RESET_INVALID);
  const reset = await PasswordReset.findOne({ tokenHash: hashResetToken(req.body.token), usedAt: null, expiresAt: { $gt: new Date() } }).populate(
    'customer',
    'name isDeleted'
  );
  if (!reset || !reset.customer || reset.customer.isDeleted) return res.status(400).json(RESET_INVALID);
  res.status(200).json({ data: { name: reset.customer.name.trim().split(/\s+/)[0] } });
});

// POST /api/portal/auth/reset-password { token, password } — sets the new password with a link from the
// forgot-password email (once; it expires after RESET_VALID_MINUTES) and logs the guest in. Any other
// links for the account stop working, and a temporary password from the team no longer has to be changed.
export const resetPassword = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const tokenError = errors.array().find((e) => e.path === 'token');
    return res.status(400).json(tokenError ? RESET_INVALID : { message: errors.array()[0].msg });
  }

  // Claim the link first, so two quick submits can't both use it.
  const reset = await PasswordReset.findOneAndUpdate(
    { tokenHash: hashResetToken(req.body.token), usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } }
  );
  if (!reset) return res.status(400).json(RESET_INVALID);
  const customer = await Customer.findOne({ _id: reset.customer, isDeleted: false }).select('+passwordHash');
  if (!customer) return res.status(400).json(RESET_INVALID);

  customer.passwordHash = await bcrypt.hash(req.body.password, 10);
  customer.mustChangePassword = false;
  await customer.save();
  await expireOpenResetLinks(customer._id);
  await recordCustomerHistory(customer, customer, 'customer', customer.name, [
    { field: 'password', from: '', to: 'Reset by guest (forgot password email)' },
  ]);

  issueSession(customer, res);
  res.status(200).json({ customer: publicCustomer(customer), message: 'Your password has been reset' });
});

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import Customer from '../models/Customer.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { CUSTOMER_COOKIE } from '../middleware/customerAuth.js';
import { recordCustomerHistory } from '../utils/customerHistory.js';

// Customer-site sessions last as long as the admin portal's "remember me" sessions.
const SESSION_MS = Number(process.env.SESSION_REMEMBER_MAX_AGE_MS) || 30 * 24 * 60 * 60 * 1000;

const mobileValidator = body('mobile')
  .trim()
  .notEmpty()
  .withMessage('Mobile number is required')
  .matches(/^[0-9]{10}$/)
  .withMessage('Enter a valid 10-digit mobile number');

export const signupValidators = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ max: 50 })
    .withMessage('Name cannot exceed 50 characters'),
  mobileValidator,
  body('email').optional({ checkFalsy: true }).trim().isEmail().withMessage('Enter a valid email address').normalizeEmail({ gmail_remove_dots: false }),
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
    { field: 'password', from: '', to: 'Changed by customer' },
  ]);

  res.status(200).json({ customer: publicCustomer(customer), message: 'Password updated successfully' });
});

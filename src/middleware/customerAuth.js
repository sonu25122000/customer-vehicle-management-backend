import jwt from 'jsonwebtoken';
import Customer from '../models/Customer.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Customer-site sessions use their own cookie (never the admin portal's `token`), and the JWT is
// marked kind:'customer' so an admin token can't be replayed here or the other way round.
export const CUSTOMER_COOKIE = 'customerToken';

// Resolves the signed-in customer from the cookie, or returns { status, message } explaining why not.
async function resolveCustomer(req) {
  const token = req.cookies?.[CUSTOMER_COOKIE];
  if (!token) return { status: 401, message: 'Please log in to continue' };

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return { status: 401, message: 'Your session has expired. Please log in again.' };
  }
  if (payload.kind !== 'customer') return { status: 401, message: 'Please log in to continue' };

  // Read fresh on every request so a customer deleted by an admin is locked out straight away.
  const customer = await Customer.findOne({ _id: payload.cid, isDeleted: false });
  if (!customer) return { status: 401, message: 'Your account is no longer available' };
  return { customer };
}

// Any signed-in customer, including one who still has to replace the password an admin gave them.
// Only for the few endpoints that must work in that state (who am I, change password).
export const requireCustomerSession = asyncHandler(async (req, res, next) => {
  const { customer, status, message } = await resolveCustomer(req);
  if (!customer) return res.status(status).json({ message });
  req.customer = customer;
  next();
});

// A signed-in customer who has set their own password. A customer an admin created (or whose
// password an admin reset) gets 403 PASSWORD_CHANGE_REQUIRED everywhere else until they change it.
export const requireCustomer = asyncHandler(async (req, res, next) => {
  const { customer, status, message } = await resolveCustomer(req);
  if (!customer) return res.status(status).json({ message });
  if (customer.mustChangePassword) {
    return res.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'Please set a new password to continue' });
  }
  req.customer = customer;
  next();
});

// Public endpoints that show a little more to a signed-in customer (e.g. offers meant only for them):
// sets req.customer when there's a usable session, otherwise carries on without one.
export const optionalCustomer = asyncHandler(async (req, _res, next) => {
  const { customer } = await resolveCustomer(req);
  if (customer && !customer.mustChangePassword) req.customer = customer;
  next();
});

import Customer from '../models/Customer.js';

// Two guests can't share an email address — it's where their password-reset links go.
export const EMAIL_IN_USE = 'This email is already used by another account. Please use a different email.';

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when another active customer (not `exceptCustomerId`) already has this email (any letter case).
export async function emailInUse(email, exceptCustomerId) {
  if (!email) return false;
  const filter = { isDeleted: false, email: new RegExp(`^${escapeRegex(email.trim())}$`, 'i') };
  if (exceptCustomerId) filter._id = { $ne: exceptCustomerId };
  return Boolean(await Customer.exists(filter));
}

import CustomerHistory from '../models/CustomerHistory.js';

// Profile fields whose edits are recorded in CustomerHistory — shared by the admin portal's
// customer edit and the customer site's profile edit, so both keep the same trail.
const TRACKED_FIELDS = ['name', 'mobile1', 'mobile2', 'email', 'customerType', 'profileVerified', 'rating', 'notes'];

function normalize(value) {
  return value === undefined || value === null ? '' : String(value);
}

// Compares a customer before and after an edit and appends one history row listing every tracked
// field that changed, plus any `extraChanges` (e.g. a password reset, recorded without the value).
// Does nothing when nothing changed.
export async function recordCustomerHistory(before, after, changedBy, changedByName = '', extraChanges = []) {
  const changes = TRACKED_FIELDS.filter((field) => normalize(before[field]) !== normalize(after[field])).map((field) => ({
    field,
    from: before[field] ?? '',
    to: after[field] ?? '',
  }));
  changes.push(...extraChanges);
  if (!changes.length) return null;
  return CustomerHistory.create({ customer: after._id, changes, changedBy, changedByName });
}

export function listCustomerHistory(customerId, limit = 100) {
  return CustomerHistory.find({ customer: customerId }).sort({ changedAt: -1 }).limit(limit).lean();
}

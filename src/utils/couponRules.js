import mongoose from 'mongoose';
import Coupon from '../models/Coupon.js';
import Trip from '../models/Trip.js';

// Rules shared by the coupon module (validation / applicable list) and the trip module
// (validating and redeeming a coupon when a trip is booked), kept in one place so "is this
// coupon usable right now?" can't drift between the two.

export const TIME_SLOT_MINUTES = 30;

// Coupon start/expiry must land exactly on a 30-minute boundary (:00 or :30, no seconds). Checked
// in UTC — for any timezone whose offset is a whole number of 30-minute steps (IST included)
// that's the same boundary as local time.
export function isOnTimeSlot(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCMinutes() % TIME_SLOT_MINUTES === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

// Not exhausted: no limit stored (legacy coupon => unlimited), or usageCount still below maxUsage.
const hasUsageLeft = {
  $or: [{ maxUsage: { $exists: false } }, { maxUsage: null }, { $expr: { $lt: ['$usageCount', '$maxUsage'] } }],
};

// Mongo filter for a coupon that can be applied to `customerId` at `now` (optionally narrowed to
// one coupon id). Used both to list the coupons the trip form offers and to atomically redeem one.
// Without a customer, only coupons open to all customers match.
export function applicableCouponFilter(customerId, now = new Date(), couponId) {
  const audience = customerId ? [{ applicability: 'all' }, { applicability: 'selected', customers: customerId }] : [{ applicability: 'all' }];
  const filter = {
    isDeleted: false,
    isActive: true,
    startAt: { $lte: now },
    expiresAt: { $gte: now },
    $and: [hasUsageLeft, { $or: audience }],
  };
  if (couponId) filter._id = couponId;
  return filter;
}

// How many times a customer has used a coupon: their trips carrying it, not counting cancelled ones
// (a cancelled booking gives the customer their use back). `excludeTripId` leaves out the trip being
// edited.
export function customerCouponUses(couponId, customerId, excludeTripId) {
  const filter = { coupon: couponId, customer: customerId, isDeleted: false, status: { $ne: 'Cancelled' } };
  if (excludeTripId) filter._id = { $ne: excludeTripId };
  return Trip.countDocuments(filter);
}

export function perCustomerLimitMessage(coupon) {
  return coupon.perCustomerLimit === 1
    ? 'This coupon can be used only once per guest, and it has already been used on this account'
    : `This coupon can be used ${coupon.perCustomerLimit} times per guest, and this account has used it up`;
}

// The per-customer limit (Coupon.perCustomerLimit): null when `customerId` can still use the coupon,
// otherwise the reason they can't.
export async function perCustomerProblem(coupon, customerId, excludeTripId) {
  if (!coupon?.perCustomerLimit || !customerId) return null;
  const used = await customerCouponUses(coupon._id, customerId, excludeTripId);
  return used >= coupon.perCustomerLimit ? perCustomerLimitMessage(coupon) : null;
}

// Ids of the coupons (among `coupons`) that `customerId` has used up under their per-customer limit.
export async function couponsUsedUpBy(coupons, customerId, excludeTripId) {
  const limited = coupons.filter((c) => c.perCustomerLimit);
  if (!limited.length || !customerId) return new Set();
  // An aggregation doesn't cast ids like find() does, so string ids (e.g. from a query string) are converted here.
  const toId = (id) => new mongoose.Types.ObjectId(String(id));
  const match = { coupon: { $in: limited.map((c) => c._id) }, customer: toId(customerId), isDeleted: false, status: { $ne: 'Cancelled' } };
  if (excludeTripId) match._id = { $ne: toId(excludeTripId) };
  const counts = await Trip.aggregate([{ $match: match }, { $group: { _id: '$coupon', n: { $sum: 1 } } }]);
  const used = new Map(counts.map((r) => [String(r._id), r.n]));
  return new Set(limited.filter((c) => (used.get(String(c._id)) || 0) >= c.perCustomerLimit).map((c) => String(c._id)));
}

// Why a typed-in coupon code can't be used right now, or null if it can. Checked one rule at a time
// so the customer gets a specific reason instead of a generic "invalid coupon".
export async function couponCodeProblem(code, customerId, now = new Date()) {
  const coupon = await Coupon.findOne({ code: String(code || '').trim().toUpperCase(), isDeleted: false });
  if (!coupon) return { message: 'This coupon code is not valid' };
  if (coupon.applicability === 'selected' && !coupon.customers.some((id) => String(id) === String(customerId))) {
    return { message: 'This coupon is not valid for your account' };
  }
  if (coupon.startAt > now) return { message: 'This coupon is not active yet' };
  if (coupon.expiresAt < now || !coupon.isActive) return { message: 'This coupon has expired or is no longer active' };
  if (coupon.maxUsage && coupon.usageCount >= coupon.maxUsage) return { message: 'This coupon has reached its usage limit' };
  const perCustomer = await perCustomerProblem(coupon, customerId);
  if (perCustomer) return { message: perCustomer };
  return { coupon };
}

// Flips every coupon that is still marked active but whose expiry has passed to inactive. Run at the
// start of each coupon read (list/stats/applicable) so stored state matches reality. It only touches
// coupons that are still active; ones already deactivated are skipped by the filter, and the
// { isActive, expiresAt } index on Coupon keeps this a cheap index scan.
export function deactivateExpiredCoupons(now = new Date()) {
  return Coupon.updateMany({ isDeleted: false, isActive: true, expiresAt: { $lt: now } }, { $set: { isActive: false } });
}

// The coupon's minimum booking amount (Coupon.minBookingAmount): null when the gross `amount` meets it,
// otherwise the reason the coupon can't be applied.
export function minBookingProblem(coupon, amount) {
  if (!coupon?.minBookingAmount) return null;
  if ((Number(amount) || 0) >= coupon.minBookingAmount) return null;
  return `This coupon is only applicable on a minimum booking of ₹${coupon.minBookingAmount.toLocaleString('en-IN')}`;
}

// Discount in rupees for a coupon on a given gross amount — a percentage of it (capped at the
// coupon's maxDiscount when it has one, e.g. 20% up to ₹100), or a flat amount — never more than the
// amount itself (so the net amount can't go negative).
export function calculateDiscount(coupon, amount) {
  const gross = Number(amount) || 0;
  let raw = coupon.discountType === 'percentage' ? (gross * coupon.value) / 100 : coupon.value;
  if (coupon.discountType === 'percentage' && coupon.maxDiscount) raw = Math.min(raw, coupon.maxDiscount);
  return Math.round(Math.min(Math.max(raw, 0), gross) * 100) / 100;
}

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
export function applicableCouponFilter(customerId, now = new Date(), couponId) {
  const filter = {
    isDeleted: false,
    isActive: true,
    startAt: { $lte: now },
    expiresAt: { $gte: now },
    $and: [hasUsageLeft, { $or: [{ applicability: 'all' }, { applicability: 'selected', customers: customerId }] }],
  };
  if (couponId) filter._id = couponId;
  return filter;
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

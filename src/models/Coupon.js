import mongoose from 'mongoose';

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Coupon code is required'],
      trim: true,
      uppercase: true,
    },
    discountType: {
      type: String,
      enum: ['percentage', 'flat'],
      required: [true, 'Discount type is required'],
    },
    // Interpreted as a percentage (capped at 100, enforced in couponController's validators) or
    // a flat rupee amount, depending on discountType.
    value: {
      type: Number,
      required: [true, 'Value is required'],
      min: [1, 'Value must be greater than 0'],
    },
    // Percentage coupons only: cap on the rupee discount (e.g. 20% up to ₹100). Left unset for
    // "no cap", and always unset for flat coupons.
    maxDiscount: {
      type: Number,
      min: [1, 'Maximum discount must be at least 1'],
    },
    applicability: {
      type: String,
      enum: ['all', 'selected'],
      default: 'all',
    },
    // Only populated (and only meaningful) when applicability === 'selected'.
    customers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Customer' }],
      default: [],
    },
    startAt: {
      type: Date,
      required: [true, 'Start date/time is required'],
    },
    expiresAt: {
      type: Date,
      required: [true, 'Expiry date/time is required'],
    },
    // Maximum number of times this coupon can be used across all trips. Optional — left unset
    // when the admin doesn't enter a limit, which means the coupon can be used an unlimited
    // number of times (see hasUsageLeft in utils/couponRules.js).
    maxUsage: {
      type: Number,
      min: [1, 'Maximum usage must be at least 1'],
      validate: { validator: Number.isInteger, message: 'Maximum usage must be a whole number' },
    },
    // Maximum number of times one customer can use this coupon (e.g. 1 for a FIRSTBOOK coupon that's
    // valid once per customer). Optional — unset means no per-customer limit. Counted from the
    // customer's trips that carry the coupon (cancelled trips don't count) — see utils/couponRules.js.
    perCustomerLimit: {
      type: Number,
      min: [1, 'Uses per guest must be at least 1'],
      validate: { validator: Number.isInteger, message: 'Uses per guest must be a whole number' },
    },
    // How many trips have used this coupon so far — only ever changed server-side, atomically, when
    // a trip is created with the coupon (see tripController.createTrip); never accepted from a
    // request body.
    usageCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Optional free-text note about the coupon, e.g. "Only applicable for Mysore trip" for code MYSORE.
    note: {
      type: String,
      trim: true,
      maxlength: [200, 'Note is too long'],
    },
    // Optional minimum booking amount (gross, before discount) for the coupon to apply. Unset means no
    // minimum — see minBookingProblem in utils/couponRules.js.
    minBookingAmount: {
      type: Number,
      min: [1, 'Minimum booking amount must be at least 1'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Shown on the customer site's offers section while live (GET /api/portal/offers). Private
    // coupons are still usable — they just aren't advertised.
    isPublic: {
      type: Boolean,
      default: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Uniqueness only enforced among active (non-deleted) coupons, so a deleted coupon's code can
// be reused — same pattern as Vehicle.vehicleNo.
couponSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
couponSchema.index({ isDeleted: 1 });
// Serves deactivateExpiredCoupons (utils/couponRules.js): finds still-active coupons past expiry.
couponSchema.index({ isActive: 1, expiresAt: 1 }, { partialFilterExpression: { isDeleted: false } });

export default mongoose.model('Coupon', couponSchema);

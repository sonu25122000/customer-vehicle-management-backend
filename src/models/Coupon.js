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
    // Maximum number of times this coupon can be used across all trips. Coupons created before
    // this field existed have no limit stored and are treated as unlimited until edited.
    maxUsage: {
      type: Number,
      min: [1, 'Maximum usage must be at least 1'],
      validate: { validator: Number.isInteger, message: 'Maximum usage must be a whole number' },
    },
    // How many trips have used this coupon so far — only ever changed server-side, atomically, when
    // a trip is created with the coupon (see tripController.createTrip); never accepted from a
    // request body.
    usageCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
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

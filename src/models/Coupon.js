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

export default mongoose.model('Coupon', couponSchema);

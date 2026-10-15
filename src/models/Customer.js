import mongoose from 'mongoose';

function stripPasswordHash(_doc, ret) {
  delete ret.passwordHash;
  return ret;
}

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: [50, 'Name cannot exceed 50 characters'],
    },
    mobile1: {
      type: String,
      required: [true, 'Mobile 1 is required'],
      trim: true,
    },
    mobile2: {
      type: String,
      trim: true,
      default: '',
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: undefined,
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    customerType: {
      type: String,
      enum: ['VIP', 'Good', 'Bad'],
      default: 'Good',
    },
    // Derived from the individual documents, never set directly: Accepted once selfie, driving
    // licence and Aadhaar are all Approved, Rejected while any of them is Rejected, Pending otherwise
    // (see utils/verification.js).
    profileVerified: {
      type: String,
      enum: ['Accepted', 'Rejected', 'Pending'],
      default: 'Pending',
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
    },
    // Who created this record: 'admin' when added from the admin portal, 'customer' when the
    // customer signed up themselves on the customer site. Set once at creation and never
    // accepted from a request body. Backfilled to 'admin' for records that predate it (see app.js).
    createdBy: {
      type: String,
      enum: ['admin', 'customer'],
      default: 'admin',
    },
    // Customer-site login (mobile1 + password). Absent for customers an admin created until the
    // customer signs up with the same mobile number, which sets it (see portalAuthController.signup).
    // Never returned by queries unless explicitly selected.
    passwordHash: {
      type: String,
      select: false,
    },
    // Set when an admin creates the customer or resets their password from the admin portal: the
    // customer has to choose their own password on their next customer-site login before they can use
    // anything else (see portalAuthController.changePassword and middleware/customerAuth.js).
    mustChangePassword: {
      type: Boolean,
      default: false,
    },
    // Verification documents (selfie, driving licence, Aadhaar, other) live in their own
    // CustomerDocument collection, linked back by customer id — see models/CustomerDocument.js.
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    // passwordHash is never serialized — `select: false` only hides it on reads, not on a document
    // that was just created or had it set (e.g. POST /customers returns the new document).
    toJSON: { getters: true, virtuals: false, transform: stripPasswordHash },
    toObject: { getters: true, virtuals: false, transform: stripPasswordHash },
  }
);

customerSchema.index({ mobile1: 1 });
customerSchema.index({ mobile2: 1 });
customerSchema.index({ name: 1 });
customerSchema.index({ isDeleted: 1 });

export default mongoose.model('Customer', customerSchema);

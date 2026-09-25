import mongoose from 'mongoose';

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
    profileVerified: {
      type: String,
      enum: ['Accepted', 'Rejected', 'Pending'],
      default: 'Pending',
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
    toJSON: { getters: true, virtuals: false },
    toObject: { getters: true, virtuals: false },
  }
);

customerSchema.index({ mobile1: 1 });
customerSchema.index({ mobile2: 1 });
customerSchema.index({ name: 1 });
customerSchema.index({ isDeleted: 1 });

export default mongoose.model('Customer', customerSchema);

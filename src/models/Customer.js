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
    // Uploaded separately from a dedicated Documents screen, after the customer is created —
    // stored as base64 data URIs directly on the document, same approach as vehicle photos.
    documents: {
      selfie: { type: String, default: '' },
      drivingLicence: { type: String, default: '' },
      aadhaar: { type: String, default: '' },
      other: { type: String, default: '' },
    },
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

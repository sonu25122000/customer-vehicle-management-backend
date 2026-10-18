import mongoose from 'mongoose';

// Email addresses collected by the customer site's "Let us know your email" section (visitors who
// aren't logged in), for offers and updates. One record per email — subscribing again is a no-op.
const subscriberSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      maxlength: [254, 'Email is too long'],
    },
    source: {
      type: String,
      trim: true,
      default: 'home',
    },
  },
  { timestamps: true }
);

subscriberSchema.index({ email: 1 }, { unique: true });

export default mongoose.model('Subscriber', subscriberSchema);

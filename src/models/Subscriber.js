import mongoose from 'mongoose';

// Email addresses collected by the customer site's "Let us know your email" section, for offers and
// updates. One record per email — subscribing again is a no-op.
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
    // When the welcome email went out (unset until it has been sent successfully).
    welcomeSentAt: { type: Date },
    // Set while a welcome email is being sent, so two quick subscribes don't send it twice.
    welcomeClaimedAt: { type: Date },
  },
  { timestamps: true }
);

subscriberSchema.index({ email: 1 }, { unique: true });

export default mongoose.model('Subscriber', subscriberSchema);

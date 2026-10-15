import mongoose from 'mongoose';

// One row per edit to a customer's profile — whether the customer edited it on the customer site
// (profile page or the booking confirmation step) or an admin edited it from the admin portal.
// Rows are only ever appended, never changed or removed, so the full edit history is kept.
const changeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    from: { type: mongoose.Schema.Types.Mixed },
    to: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const customerHistorySchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    changes: {
      type: [changeSchema],
      default: [],
    },
    changedBy: {
      type: String,
      enum: ['admin', 'customer'],
      required: true,
    },
    // Admin username, or the customer's name at the time of the edit.
    changedByName: {
      type: String,
      default: '',
    },
  },
  { timestamps: { createdAt: 'changedAt', updatedAt: false } }
);

customerHistorySchema.index({ customer: 1, changedAt: -1 });

export default mongoose.model('CustomerHistory', customerHistorySchema);

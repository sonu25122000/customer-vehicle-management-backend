import mongoose from 'mongoose';

// One "forgot password" link emailed to a customer (portalAuthController.forgotPassword). Only a SHA-256
// hash of the link's token is stored, so the database alone can't be used to reset anyone's password.
// A link works once (usedAt), until expiresAt; asking for a new link removes the customer's older ones.
// MongoDB deletes rows a day after they expire (TTL index), so the collection stays small.
const passwordResetSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    tokenHash: { type: String, required: true },
    // The address the link was sent to.
    email: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true }
);

passwordResetSchema.index({ tokenHash: 1 }, { unique: true });
passwordResetSchema.index({ customer: 1, createdAt: -1 });
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export default mongoose.model('PasswordReset', passwordResetSchema);

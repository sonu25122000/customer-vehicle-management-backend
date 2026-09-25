import mongoose from 'mongoose';

export const CUSTOMER_DOCUMENT_TYPES = ['selfie', 'drivingLicence', 'aadhaar', 'other'];

// One row per uploaded customer verification document, linked to its customer by id. These used to
// be embedded on the Customer record (customer.documents.*). Keeping them in their own collection
// means customer lists and lookups never carry the file data, and each file is its own document
// rather than counting towards one customer's 16MB limit.
//
// Re-uploading a type soft-deletes the previous row and adds a new one, so there's at most one
// active row per customer per type.
const customerDocumentSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: [true, 'Customer is required'],
    },
    type: {
      type: String,
      enum: CUSTOMER_DOCUMENT_TYPES,
      required: [true, 'Document type is required'],
    },
    // base64 data URI (image or PDF), same storage approach as before, since no object storage is
    // configured for this project.
    file: {
      type: String,
      required: true,
    },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

customerDocumentSchema.index({ customer: 1, isDeleted: 1, type: 1 });

export default mongoose.model('CustomerDocument', customerDocumentSchema);

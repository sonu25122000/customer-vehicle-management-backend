import mongoose from 'mongoose';

export const CUSTOMER_DOCUMENT_TYPES = ['selfie', 'drivingLicence', 'aadhaar', 'other'];
// The documents that must all be Approved for the profile to count as verified ('other' is optional).
export const REQUIRED_DOCUMENT_TYPES = ['selfie', 'drivingLicence', 'aadhaar'];
export const DOCUMENT_STATUSES = ['Pending', 'Approved', 'Rejected'];

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
    // The file's object key in the S3 bucket (utils/storage.js). `file` is legacy: files uploaded before
    // S3 was introduced were stored here as a base64 data URI. It's never written any more, and
    // `npm run migrate:s3` moves those files into S3 and clears it.
    s3Key: { type: String },
    file: { type: String },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    // Generated server-side from the customer's details and the document type (utils/fileNames.js),
    // e.g. RAVI-KUMAR_9876543210_AADHAAR_20261015-103000.jpg. originalName is what was uploaded.
    fileName: { type: String, default: '' },
    originalName: { type: String, default: '' },
    uploadedBy: { type: String, enum: ['admin', 'customer'], default: 'admin' },
    // Each document is reviewed on its own — a new upload of one type only puts that document back to
    // Pending, the others keep their review. The customer's profileVerified is derived from these
    // (utils/verification.js).
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'Pending' },
    rejectionReason: { type: String, trim: true, default: '' },
    reviewedAt: { type: Date },
    reviewedBy: { type: String, default: '' },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

customerDocumentSchema.pre('validate', function requireFile(next) {
  if (!this.s3Key && !this.file) this.invalidate('file', 'File is required');
  next();
});

customerDocumentSchema.index({ customer: 1, isDeleted: 1, type: 1 });

export default mongoose.model('CustomerDocument', customerDocumentSchema);

import Customer from '../models/Customer.js';
import CustomerDocument, { REQUIRED_DOCUMENT_TYPES } from '../models/CustomerDocument.js';
import { recordCustomerHistory } from './customerHistory.js';

// A customer's profileVerified is derived from their individual documents, never set by hand:
//  - Accepted: selfie, driving licence and Aadhaar are all on file and Approved
//  - Rejected: at least one of those is Rejected (the customer re-uploads just that one)
//  - Pending:  anything else (missing, or waiting for review)
// The optional 'other' document doesn't affect it.
export function deriveProfileStatus(documents) {
  const byType = new Map(documents.filter((d) => !d.isDeleted).map((d) => [d.type, d.status || 'Pending']));
  const required = REQUIRED_DOCUMENT_TYPES.map((type) => byType.get(type));
  if (required.some((status) => status === 'Rejected')) return 'Rejected';
  if (required.every((status) => status === 'Approved')) return 'Accepted';
  return 'Pending';
}

// Recomputes and stores the customer's profileVerified after any document upload or review, and notes
// the change in their edit history. Returns the (possibly unchanged) status.
export async function syncProfileVerification(customerId, changedBy, changedByName = '') {
  const [customer, documents] = await Promise.all([
    Customer.findOne({ _id: customerId, isDeleted: false }),
    CustomerDocument.find({ customer: customerId, isDeleted: false }, 'type status').lean(),
  ]);
  if (!customer) return null;

  const status = deriveProfileStatus(documents);
  if (customer.profileVerified !== status) {
    const before = customer.toObject();
    customer.profileVerified = status;
    await customer.save();
    await recordCustomerHistory(before, customer, changedBy, changedByName);
  }
  return status;
}

// What the customer site and admin portal show for each document (never the file itself).
export function documentSummary(d) {
  return {
    _id: d._id,
    type: d.type,
    status: d.status || 'Pending',
    rejectionReason: d.status === 'Rejected' ? d.rejectionReason || '' : '',
    fileName: d.fileName || '',
    uploadedBy: d.uploadedBy || 'admin',
    uploadedAt: d.createdAt,
    reviewedAt: d.reviewedAt,
  };
}

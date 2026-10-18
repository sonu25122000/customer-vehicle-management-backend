import { body, query, validationResult } from 'express-validator';
import Customer from '../models/Customer.js';
import CustomerDocument, { CUSTOMER_DOCUMENT_TYPES } from '../models/CustomerDocument.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { objectKey, storeFile, withFileUrls } from '../utils/storage.js';
import { customerDocumentFileName, customerDocumentKeyParts } from '../utils/fileNames.js';
import { syncProfileVerification } from '../utils/verification.js';

const CUSTOMER_POPULATE = 'name mobile1 profileVerified';
const MAX_REASON_LENGTH = 300;

export const listValidators = [query('customer').isMongoId().withMessage('A valid guest is required')];
export const uploadValidators = [body('customer').isMongoId().withMessage('A valid guest is required')];

export const reviewValidators = [
  body('customer').isMongoId().withMessage('A valid guest is required'),
  body('status').isIn(['Approved', 'Rejected']).withMessage('Status must be Approved or Rejected'),
  body('documents')
    .optional()
    .isArray({ min: 1 })
    .withMessage('Select at least one document')
    .custom((ids) => ids.every((id) => /^[0-9a-fA-F]{24}$/.test(id)))
    .withMessage('Invalid document selection'),
  body('reason')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: MAX_REASON_LENGTH })
    .withMessage(`Reason cannot exceed ${MAX_REASON_LENGTH} characters`),
  body('reason').if(body('status').equals('Rejected')).trim().notEmpty().withMessage('Enter a reason for rejecting'),
];

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

// The customer's documents, each with `file` set to a short-lived URL of the file in S3.
async function findActiveForCustomer(customerId) {
  const rows = await CustomerDocument.find({ customer: customerId, isDeleted: false })
    .populate('customer', CUSTOMER_POPULATE)
    .sort({ createdAt: 1 });
  return withFileUrls(rows, 'file');
}

// Stores newly uploaded documents for a customer — shared by the admin portal (here) and the customer
// site (portalController.uploadDocuments). Each uploaded type replaces that customer's previous
// document of the same type and starts out Pending review; documents of other types keep their review
// as they are. Every file gets a generated name (utils/fileNames.js), which is also its S3 object name.
export async function storeCustomerDocuments(customer, uploads, uploadedBy) {
  const now = new Date();
  // Files go to S3 first, so a failed upload leaves the customer's current documents untouched.
  const named = uploads.map((u) => ({ ...u, fileName: customerDocumentFileName(customer, u.type, u.file, now) }));
  const keys = await Promise.all(
    named.map(({ type, file, fileName }) => storeFile(file, objectKey(...customerDocumentKeyParts(customer, type, fileName))))
  );
  await CustomerDocument.updateMany(
    { customer: customer._id, type: { $in: uploads.map((u) => u.type) }, isDeleted: false },
    { $set: { isDeleted: true } }
  );
  await CustomerDocument.insertMany(
    named.map(({ type, file, fileName }, i) => ({
      customer: customer._id,
      type,
      s3Key: keys[i],
      mimeType: file.mimetype,
      size: file.size,
      fileName,
      originalName: file.originalname || '',
      uploadedBy,
      status: 'Pending',
    }))
  );
}

// GET /api/customer-documents?customer=<id>
export const listCustomerDocuments = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  res.status(200).json({ data: await findActiveForCustomer(req.query.customer) });
});

// GET /api/customer-documents/:id
export const getCustomerDocument = asyncHandler(async (req, res) => {
  const document = await CustomerDocument.findOne({ _id: req.params.id, isDeleted: false }).populate(
    'customer',
    CUSTOMER_POPULATE
  );
  if (!document) {
    return res.status(404).json({ message: 'Document not found' });
  }
  const [withUrl] = await withFileUrls([document], 'file');
  res.status(200).json({ data: withUrl });
});

// POST /api/customer-documents (multipart/form-data: customer + any of selfie/drivingLicence/aadhaar/other)
export const uploadCustomerDocuments = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const customer = await Customer.findOne({ _id: req.body.customer, isDeleted: false }, '_id name mobile1');
  if (!customer) {
    return res.status(404).json({ message: 'Guest not found' });
  }

  const files = req.files || {};
  const uploads = CUSTOMER_DOCUMENT_TYPES.filter((type) => files[type]?.[0]).map((type) => ({ type, file: files[type][0] }));
  if (!uploads.length) {
    return res.status(400).json({ message: 'Select at least one document to upload' });
  }

  await storeCustomerDocuments(customer, uploads, 'admin');
  const profileVerified = await syncProfileVerification(customer._id, 'admin', req.admin?.username);

  res.status(200).json({
    data: await findActiveForCustomer(customer._id),
    profileVerified,
    message: 'Documents uploaded successfully',
  });
});

// POST /api/customer-documents/review — the one endpoint for approving or rejecting verification
// documents, whether the customer uploaded them on the customer site or an admin uploaded them here.
//   { customer, status: 'Approved'|'Rejected', documents?: [id, ...], reason? }
// With `documents`, only those are reviewed (one document at a time, or a few); without it, every
// document the customer has on file is — i.e. accepting/rejecting the whole profile in one go.
// Rejecting needs a reason, which the customer sees next to that document so they know what to fix.
// The customer's profileVerified is recomputed from the documents afterwards: it only becomes
// Accepted once selfie, driving licence and Aadhaar are all Approved.
export const reviewCustomerDocuments = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { customer: customerId, status, documents } = req.body;
  const customer = await Customer.findOne({ _id: customerId, isDeleted: false }, '_id');
  if (!customer) {
    return res.status(404).json({ message: 'Guest not found' });
  }

  const filter = { customer: customer._id, isDeleted: false };
  if (documents) filter._id = { $in: documents };
  const matching = await CustomerDocument.countDocuments(filter);
  if (!matching || (documents && matching !== documents.length)) {
    return res.status(400).json({
      message: documents ? "Some of these documents aren't on file for this guest any more" : 'This guest has no documents to review',
    });
  }

  await CustomerDocument.updateMany(filter, {
    $set: {
      status,
      rejectionReason: status === 'Rejected' ? req.body.reason.trim() : '',
      reviewedAt: new Date(),
      reviewedBy: req.admin?.username || '',
    },
  });
  const profileVerified = await syncProfileVerification(customer._id, 'admin', req.admin?.username);

  const count = documents ? documents.length : matching;
  res.status(200).json({
    data: await findActiveForCustomer(customer._id),
    profileVerified,
    message: `${count} document${count === 1 ? '' : 's'} ${status.toLowerCase()}`,
  });
});

// DELETE /api/customer-documents/:id — soft delete
export const deleteCustomerDocument = asyncHandler(async (req, res) => {
  const document = await CustomerDocument.findOneAndUpdate(
    { _id: req.params.id, isDeleted: false },
    { isDeleted: true },
    { new: true }
  );
  if (!document) {
    return res.status(404).json({ message: 'Document not found' });
  }
  // A removed required document takes an Accepted profile back to Pending.
  await syncProfileVerification(document.customer, 'admin', req.admin?.username);
  res.status(200).json({ message: 'Document deleted successfully' });
});

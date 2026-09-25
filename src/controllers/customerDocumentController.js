import { body, query, validationResult } from 'express-validator';
import Customer from '../models/Customer.js';
import CustomerDocument, { CUSTOMER_DOCUMENT_TYPES } from '../models/CustomerDocument.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toDataUri } from '../utils/media.js';

const CUSTOMER_POPULATE = 'name mobile1';

export const listValidators = [query('customer').isMongoId().withMessage('A valid customer is required')];
export const uploadValidators = [body('customer').isMongoId().withMessage('A valid customer is required')];

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

function findActiveForCustomer(customerId) {
  return CustomerDocument.find({ customer: customerId, isDeleted: false })
    .populate('customer', CUSTOMER_POPULATE)
    .sort({ createdAt: 1 });
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
  res.status(200).json({ data: document });
});

// POST /api/customer-documents (multipart/form-data: customer + any of selfie/drivingLicence/aadhaar/other)
// Each uploaded type replaces that customer's previous document of the same type.
export const uploadCustomerDocuments = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const customer = await Customer.findOne({ _id: req.body.customer, isDeleted: false }, '_id');
  if (!customer) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  const files = req.files || {};
  const uploads = CUSTOMER_DOCUMENT_TYPES.filter((type) => files[type]?.[0]).map((type) => ({ type, file: files[type][0] }));
  if (!uploads.length) {
    return res.status(400).json({ message: 'Select at least one document to upload' });
  }

  await CustomerDocument.updateMany(
    { customer: customer._id, type: { $in: uploads.map((u) => u.type) }, isDeleted: false },
    { $set: { isDeleted: true } }
  );
  await CustomerDocument.insertMany(
    uploads.map(({ type, file }) => ({
      customer: customer._id,
      type,
      file: toDataUri(file),
      mimeType: file.mimetype,
      size: file.size,
    }))
  );

  res.status(200).json({ data: await findActiveForCustomer(customer._id), message: 'Documents uploaded successfully' });
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
  res.status(200).json({ message: 'Document deleted successfully' });
});

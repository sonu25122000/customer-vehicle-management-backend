import { body, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import Trip from '../models/Trip.js';
import { asyncHandler } from '../utils/asyncHandler.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SORT_MAP = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name_asc: { name: 1 },
  name_desc: { name: -1 },
};

const CUSTOMER_TYPES = ['VIP', 'Good', 'Bad'];
const PROFILE_VERIFIED_STATUSES = ['Accepted', 'Rejected', 'Pending'];
const MAX_NOTES_WORDS = 300;

const dateRangeValidators = [
  query('startDate').optional({ checkFalsy: true }).isISO8601().withMessage('Invalid start date'),
  query('endDate').optional({ checkFalsy: true }).isISO8601().withMessage('Invalid end date'),
];

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

const customerIdsValidator = query('customerIds')
  .optional({ checkFalsy: true })
  .custom((value) => {
    const ids = String(value).split(',').filter(Boolean);
    if (!ids.every((id) => OBJECT_ID_RE.test(id))) {
      throw new Error('Invalid customer selection');
    }
    return true;
  });

const notesValidator = body('notes')
  .optional({ checkFalsy: true })
  .trim()
  .custom((value) => {
    const wordCount = value.split(/\s+/).filter(Boolean).length;
    if (wordCount > MAX_NOTES_WORDS) {
      throw new Error(`Notes cannot exceed ${MAX_NOTES_WORDS} words`);
    }
    return true;
  });

// Shared filter builder used by list and stats so both stay in sync.
function buildFilter({ search, minRating, startDate, endDate, customerIds }) {
  const filter = { isDeleted: false };

  if (search) {
    const regex = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ name: regex }, { mobile1: regex }, { mobile2: regex }];
  }
  if (minRating) {
    filter.rating = { $gte: Number(minRating) };
  }
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }
  if (customerIds) {
    const ids = String(customerIds).split(',').filter(Boolean);
    if (ids.length) filter._id = { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  return filter;
}

// Trip now owns booking history — "Last Booked Date" is the most recent non-deleted trip's
// start date for each customer, computed on read rather than stored redundantly on Customer.
async function attachLastBookedDates(customers) {
  const ids = customers.map((c) => c._id);
  if (!ids.length) return customers;

  const rows = await Trip.aggregate([
    { $match: { customer: { $in: ids }, isDeleted: false } },
    { $sort: { startDate: -1 } },
    { $group: { _id: '$customer', lastBookedDate: { $first: '$startDate' } } },
  ]);
  const byId = new Map(rows.map((r) => [String(r._id), r.lastBookedDate]));

  return customers.map((c) => {
    const obj = c.toObject ? c.toObject() : c;
    return { ...obj, lastBookedDate: byId.get(String(c._id)) || null };
  });
}

export const listValidators = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('minRating').optional({ checkFalsy: true }).isInt({ min: 1, max: 5 }).toInt(),
  query('sort').optional({ checkFalsy: true }).isIn(Object.keys(SORT_MAP)),
  customerIdsValidator,
  ...dateRangeValidators,
];

export const statsValidators = [customerIdsValidator, ...dateRangeValidators];

export const customerValidators = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ max: 50 })
    .withMessage('Name cannot exceed 50 characters'),
  body('mobile1')
    .trim()
    .notEmpty()
    .withMessage('Mobile 1 is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Mobile 1 must be exactly 10 digits'),
  body('mobile2')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[0-9]{10}$/)
    .withMessage('Mobile 2 must be exactly 10 digits'),
  body('rating')
    .optional({ checkFalsy: true })
    .isInt({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),
  body('customerType').optional({ checkFalsy: true }).isIn(CUSTOMER_TYPES).withMessage('Invalid customer type'),
  body('profileVerified')
    .optional({ checkFalsy: true })
    .isIn(PROFILE_VERIFIED_STATUSES)
    .withMessage('Invalid profile verified status'),
  notesValidator,
];

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

// GET /api/customers?search=&page=&limit=
export const listCustomers = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const page = req.query.page || 1;
  const limit = req.query.limit || 10;
  const sort = SORT_MAP[req.query.sort] || SORT_MAP.newest;
  const filter = buildFilter(req.query);

  const [customers, total] = await Promise.all([
    Customer.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit),
    Customer.countDocuments(filter),
  ]);

  res.status(200).json({
    data: await attachLastBookedDates(customers),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    },
  });
});

// GET /api/customers/options — lightweight list for the "select customer" filter picker
// and the Trip form's customer dropdown (searchable by name/mobile).
export const listCustomerOptions = asyncHandler(async (req, res) => {
  const customers = await Customer.find({ isDeleted: false }, 'name mobile1 mobile2')
    .sort({ name: 1 })
    .limit(1000);
  res.status(200).json({ data: customers });
});

// GET /api/customers/:id
export const getCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    return res.status(404).json({ message: 'Customer not found' });
  }
  const [withLastBooked] = await attachLastBookedDates([customer]);
  res.status(200).json({ data: withLastBooked });
});

// POST /api/customers
export const createCustomer = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { name, mobile1, mobile2, notes, customerType } = req.body;

  const duplicateMobile = await Customer.findOne({ mobile1: mobile1.trim(), isDeleted: false });
  if (duplicateMobile) {
    return res.status(409).json({ message: 'A customer with this mobile number already exists' });
  }

  // A brand new customer can't be rated yet and always starts out unverified — rating and
  // profileVerified are never accepted from the client at creation time (see CustomerFormModal,
  // which disables both controls on the create form for the same reason).
  const customer = await Customer.create({
    name,
    mobile1,
    mobile2,
    notes,
    customerType: customerType || undefined,
    profileVerified: 'Pending',
  });

  res.status(201).json({ data: customer, message: 'Customer created successfully' });
});

// PUT/PATCH /api/customers/:id
export const updateCustomer = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { name, mobile1, mobile2, rating, notes, customerType, profileVerified } = req.body;

  const duplicateMobile = await Customer.findOne({
    _id: { $ne: req.params.id },
    mobile1: mobile1.trim(),
    isDeleted: false,
  });
  if (duplicateMobile) {
    return res.status(409).json({ message: 'A customer with this mobile number already exists' });
  }

  const customer = await Customer.findOneAndUpdate(
    { _id: req.params.id, isDeleted: false },
    {
      name,
      mobile1,
      mobile2,
      rating: rating || undefined,
      notes,
      customerType: customerType || undefined,
      profileVerified: profileVerified || undefined,
    },
    { new: true, runValidators: true }
  );

  if (!customer) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  res.status(200).json({ data: customer, message: 'Customer updated successfully' });
});

// DELETE /api/customers/:id — soft delete
export const deleteCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findOneAndUpdate(
    { _id: req.params.id, isDeleted: false },
    { isDeleted: true },
    { new: true }
  );
  if (!customer) {
    return res.status(404).json({ message: 'Customer not found' });
  }
  res.status(200).json({ message: 'Customer deleted successfully' });
});

const DOCUMENT_FIELDS = { selfie: 'selfie', drivingLicence: 'drivingLicence', aadhaar: 'aadhaar', other: 'other' };

function toDataUri(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

// POST /api/customers/:id/documents (multipart/form-data)
export const uploadCustomerDocuments = asyncHandler(async (req, res) => {
  const customer = await Customer.findOne({ _id: req.params.id, isDeleted: false });
  if (!customer) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  const files = req.files || {};
  for (const field of Object.keys(DOCUMENT_FIELDS)) {
    if (files[field]?.[0]) {
      customer.documents[field] = toDataUri(files[field][0]);
    }
  }

  await customer.save();
  res.status(200).json({ data: customer, message: 'Documents uploaded successfully' });
});

// GET /api/customers/stats?startDate=&endDate=
export const getStats = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const filter = buildFilter(req.query);

  const [summary] = await Customer.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        totalCustomers: { $sum: 1 },
        avgRating: { $avg: '$rating' },
      },
    },
  ]);

  // Preserve an existing minRating constraint on `rating` rather than clobbering it —
  // only fall back to "must have a rating at all" when no rating filter was requested.
  const ratingRows = await Customer.aggregate([
    { $match: { ...filter, rating: filter.rating || { $exists: true } } },
    { $group: { _id: '$rating', count: { $sum: 1 } } },
  ]);
  const ratingCounts = Object.fromEntries(ratingRows.map((r) => [r._id, r.count]));
  const ratingDistribution = [1, 2, 3, 4, 5].map((rating) => ({ rating, count: ratingCounts[rating] || 0 }));

  const typeRows = await Customer.aggregate([{ $match: filter }, { $group: { _id: '$customerType', count: { $sum: 1 } } }]);
  const typeCountsRaw = Object.fromEntries(typeRows.map((r) => [r._id, r.count]));
  const typeCounts = {
    VIP: typeCountsRaw.VIP || 0,
    Good: typeCountsRaw.Good || 0,
    Bad: typeCountsRaw.Bad || 0,
  };

  const recentCustomers = await Customer.find(filter).sort({ createdAt: -1 }).limit(5);

  res.status(200).json({
    data: {
      totalCustomers: summary?.totalCustomers || 0,
      avgRating: summary?.avgRating ? Math.round(summary.avgRating * 10) / 10 : 0,
      ratingDistribution,
      typeCounts,
      recentCustomers: await attachLastBookedDates(recentCustomers),
    },
  });
});

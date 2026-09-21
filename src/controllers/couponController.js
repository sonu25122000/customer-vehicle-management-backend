import { body, query, validationResult } from 'express-validator';
import Coupon from '../models/Coupon.js';
import { asyncHandler } from '../utils/asyncHandler.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CUSTOMERS_POPULATE = 'name mobile1 mobile2';

export const listValidators = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const couponValidators = [
  body('code').trim().notEmpty().withMessage('Coupon code is required').isLength({ max: 30 }).withMessage('Coupon code is too long'),
  body('discountType').trim().notEmpty().withMessage('Discount type is required').isIn(['percentage', 'flat']).withMessage('Invalid discount type'),
  body('value')
    .notEmpty()
    .withMessage('Value is required')
    .isFloat({ min: 1 })
    .withMessage('Value must be greater than 0')
    .custom((value, { req }) => {
      if (req.body.discountType === 'percentage' && Number(value) > 100) {
        throw new Error('Percentage discount cannot exceed 100');
      }
      return true;
    }),
  body('applicability').trim().notEmpty().withMessage('Applicability is required').isIn(['all', 'selected']).withMessage('Invalid applicability'),
  body('customers')
    .custom((value, { req }) => {
      if (req.body.applicability !== 'selected') return true;
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error('Select at least one customer');
      }
      if (!value.every((id) => /^[0-9a-fA-F]{24}$/.test(id))) {
        throw new Error('Invalid customer selection');
      }
      return true;
    }),
  body('startAt').notEmpty().withMessage('Start date/time is required').isISO8601().withMessage('Invalid start date/time'),
  body('expiresAt')
    .notEmpty()
    .withMessage('Expiry date/time is required')
    .isISO8601()
    .withMessage('Invalid expiry date/time')
    .custom((value, { req }) => {
      if (req.body.startAt && new Date(value) <= new Date(req.body.startAt)) {
        throw new Error('Expiry must be after the start date/time');
      }
      return true;
    }),
  body('isActive').optional().isBoolean().withMessage('Invalid status').toBoolean(),
];

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

async function findDuplicate(code, excludeId) {
  const filter = { code: code.trim().toUpperCase(), isDeleted: false };
  if (excludeId) filter._id = { $ne: excludeId };
  return Coupon.findOne(filter);
}

// GET /api/coupons?search=&page=&limit=
export const listCoupons = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const page = req.query.page || 1;
  const limit = req.query.limit || 10;
  const search = (req.query.search || '').trim();

  const filter = { isDeleted: false };
  if (search) {
    filter.code = new RegExp(escapeRegex(search), 'i');
  }

  const [coupons, total] = await Promise.all([
    Coupon.find(filter)
      .populate('customers', CUSTOMERS_POPULATE)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Coupon.countDocuments(filter),
  ]);

  res.status(200).json({
    data: coupons,
    pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
  });
});

// GET /api/coupons/stats — Total / Active / Expired, for the Coupons page stat tiles
export const getCouponStats = asyncHandler(async (_req, res) => {
  const now = new Date();
  const [total, active, expired] = await Promise.all([
    Coupon.countDocuments({ isDeleted: false }),
    Coupon.countDocuments({ isDeleted: false, isActive: true, startAt: { $lte: now }, expiresAt: { $gte: now } }),
    Coupon.countDocuments({ isDeleted: false, expiresAt: { $lt: now } }),
  ]);
  res.status(200).json({ data: { total, active, expired } });
});

// GET /api/coupons/:id
export const getCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOne({ _id: req.params.id, isDeleted: false }).populate('customers', CUSTOMERS_POPULATE);
  if (!coupon) {
    return res.status(404).json({ message: 'Coupon not found' });
  }
  res.status(200).json({ data: coupon });
});

// POST /api/coupons
export const createCoupon = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { code, discountType, value, applicability, customers, startAt, expiresAt } = req.body;

  const duplicate = await findDuplicate(code);
  if (duplicate) {
    return res.status(409).json({ message: 'A coupon with this code already exists' });
  }

  const coupon = await Coupon.create({
    code,
    discountType,
    value,
    applicability,
    customers: applicability === 'selected' ? customers : [],
    startAt,
    expiresAt,
  });
  await coupon.populate('customers', CUSTOMERS_POPULATE);

  res.status(201).json({ data: coupon, message: 'Coupon created successfully' });
});

// PUT/PATCH /api/coupons/:id
export const updateCoupon = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { code, discountType, value, applicability, customers, startAt, expiresAt, isActive } = req.body;

  const duplicate = await findDuplicate(code, req.params.id);
  if (duplicate) {
    return res.status(409).json({ message: 'A coupon with this code already exists' });
  }

  const coupon = await Coupon.findOne({ _id: req.params.id, isDeleted: false });
  if (!coupon) {
    return res.status(404).json({ message: 'Coupon not found' });
  }

  coupon.set({
    code,
    discountType,
    value,
    applicability,
    customers: applicability === 'selected' ? customers : [],
    startAt,
    expiresAt,
    isActive: isActive === undefined ? coupon.isActive : isActive,
  });
  await coupon.save();
  await coupon.populate('customers', CUSTOMERS_POPULATE);

  res.status(200).json({ data: coupon, message: 'Coupon updated successfully' });
});

// DELETE /api/coupons/:id — soft delete
export const deleteCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOneAndUpdate(
    { _id: req.params.id, isDeleted: false },
    { isDeleted: true },
    { new: true }
  );
  if (!coupon) {
    return res.status(404).json({ message: 'Coupon not found' });
  }
  res.status(200).json({ message: 'Coupon deleted successfully' });
});

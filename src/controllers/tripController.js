import crypto from 'crypto';
import { body, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import Trip from '../models/Trip.js';
import Customer from '../models/Customer.js';
import Vehicle from '../models/Vehicle.js';
import Coupon from '../models/Coupon.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { applicableCouponFilter, calculateDiscount } from '../utils/couponRules.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STATUSES = ['On Trip', 'Yet to Start', 'Completed', 'Cancelled'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CUSTOMER_POPULATE = 'name mobile1 mobile2 customerType';
const VEHICLE_POPULATE = 'vehicleNo vehicleType vehicleCategory make model year ownerName';

// No 0/O/1/I — avoids characters that are easy to misread/mistype when a customer reads a
// trip ID back over the phone.
const TRIP_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// RW (Roam Wheels) + booking month + booking year (2 digits) + a 4-character random code,
// e.g. RW0926AXYZ. Meaningful (company + when it was booked) while still short enough to read
// out loud, and the random suffix keeps it non-guessable/non-sequential.
export function buildTripId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const suffix = Array.from({ length: 4 }, () => TRIP_CODE_CHARS[crypto.randomInt(TRIP_CODE_CHARS.length)]).join('');
  return `RW${mm}${yy}${suffix}`;
}

// The unique index is the real dedup guarantee — this loop (plus the E11000 catch at the call
// site) just avoids relying on luck alone across many bookings in the same month.
async function generateUniqueTripId() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = buildTripId();
    // eslint-disable-next-line no-await-in-loop
    const clash = await Trip.exists({ tripId: candidate });
    if (!clash) return candidate;
  }
  throw new Error('Could not generate a unique trip ID, please try again');
}

// A trip's status only ever moves forward along one of these paths — Completed and Cancelled
// are terminal. Keying by CURRENT status gives the set of statuses a request is allowed to
// move to (including staying put).
const ALLOWED_STATUS_TRANSITIONS = {
  'Yet to Start': ['Yet to Start', 'On Trip', 'Cancelled'],
  // Once a trip is under way it can no longer be cancelled — the only forward path is Completed.
  'On Trip': ['On Trip', 'Completed'],
  Completed: ['Completed'],
  Cancelled: ['Cancelled'],
};
// Fields a client may change once a trip has reached each status. Anything not listed here
// is silently kept at its existing stored value, regardless of what the request body sends —
// this is enforced server-side so it can't be bypassed by calling the API directly.
const AMOUNT_FIELDS = ['amount', 'tollCharges', 'advance', 'securityDeposit'];
const EDITABLE_FIELDS_BY_STATUS = {
  // Customer is never editable once a trip exists — only settable at creation time (see
  // createTrip). Only vehicle/start date+time can still change while "Yet to Start".
  'Yet to Start': [
    'vehicle', 'startDate', 'startTime', 'endDate', 'endTime',
    ...AMOUNT_FIELDS, 'startOdometer', 'endOdometer', 'status',
  ],
  // Vehicle/customer/start date+time are locked once a trip is under way — see checkVehicleRentals's
  // "Trip lifecycle" rules. Reschedule (POST /:id/reschedule) is the only way to change start date/time.
  'On Trip': ['endDate', 'endTime', ...AMOUNT_FIELDS, 'startOdometer', 'endOdometer', 'status', 'rating'],
  // Amount-related fields, odometer readings and rating remain editable after completion — e.g.
  // correcting the final odometer reading once the vehicle is back.
  Completed: [...AMOUNT_FIELDS, 'startOdometer', 'endOdometer', 'rating'],
  // Cancellation is a one-shot action (see cancelTrip) — no further edits after that.
  Cancelled: [],
};

export const listValidators = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('status').optional({ checkFalsy: true }).isIn(STATUSES),
  query('minRating').optional({ checkFalsy: true }).isInt({ min: 1, max: 5 }).toInt(),
  query('startDate').optional({ checkFalsy: true }).isISO8601(),
  query('endDate').optional({ checkFalsy: true }).isISO8601(),
];

export const tripValidators = [
  body('customer').trim().notEmpty().withMessage('Customer is required').isMongoId().withMessage('Invalid customer selected'),
  body('vehicle').trim().notEmpty().withMessage('Vehicle is required').isMongoId().withMessage('Invalid vehicle selected'),
  body('startDate').notEmpty().withMessage('Start date is required').isISO8601().withMessage('Invalid start date'),
  body('startTime')
    .trim()
    .notEmpty()
    .withMessage('Start time is required')
    .matches(TIME_RE)
    .withMessage('Start time must be in HH:mm format'),
  body('endDate').notEmpty().withMessage('End date is required').isISO8601().withMessage('Invalid end date'),
  body('endTime').optional({ checkFalsy: true }).trim().matches(TIME_RE).withMessage('End time must be in HH:mm format'),
  body('amount').notEmpty().withMessage('Amount is required').isFloat({ min: 0 }).withMessage('Amount must be a positive number'),
  body('tollCharges').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Toll charges must be a positive number'),
  body('advance').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Advance must be a positive number'),
  body('securityDeposit')
    .optional({ checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage('Security deposit must be a positive number'),
  body('refundAmount').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Refund amount must be a positive number'),
  body('startOdometer').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Starting odometer must be a positive number'),
  body('endOdometer').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Ending odometer must be a positive number'),
  // Optional; only honoured when creating a trip (see createTrip) — ignored on update.
  body('coupon').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid coupon selected'),
  body('status').trim().notEmpty().withMessage('Trip status is required').isIn(STATUSES).withMessage('Invalid trip status'),
  body('rating').optional({ checkFalsy: true }).isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
];

export const rescheduleValidators = [
  body('startDate').notEmpty().withMessage('Start date is required').isISO8601().withMessage('Invalid start date'),
  body('startTime')
    .trim()
    .notEmpty()
    .withMessage('Start time is required')
    .matches(TIME_RE)
    .withMessage('Start time must be in HH:mm format'),
];

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

// Cross-field checks that don't fit express-validator's per-field chain shape.
function checkBusinessRules(body) {
  if (body.status === 'Completed' && (!body.endDate || !body.endTime)) {
    return 'End date and end time are required to mark a trip as Completed';
  }
  if (body.startDate && body.endDate) {
    // Both are 'YYYY-MM-DD'/'HH:mm' strings (never .toDate()'d by the validators); any time part
    // on a date is dropped so lexicographic comparison is equivalent to chronological comparison,
    // and so "same day" is judged on the calendar date alone.
    const startDay = String(body.startDate).slice(0, 10);
    const endDay = String(body.endDate).slice(0, 10);
    if (endDay < startDay) {
      return 'End date cannot be before start date';
    }
    if (endDay === startDay && body.startTime && body.endTime && body.endTime < body.startTime) {
      return 'End time cannot be before start time on the same day';
    }
  }
  if (
    body.startOdometer !== undefined &&
    body.startOdometer !== '' &&
    body.endOdometer !== undefined &&
    body.endOdometer !== '' &&
    Number(body.endOdometer) < Number(body.startOdometer)
  ) {
    return 'Ending odometer reading cannot be less than the starting reading';
  }
  if (body.advance !== undefined && body.advance !== '' && body.amount !== undefined && body.amount !== '') {
    if (Number(body.advance) > Number(body.amount)) {
      return 'Advance cannot be greater than the trip amount';
    }
  }
  return null;
}

// A vehicle can only be actively "On Trip" once at a time — this is a status lock, not a
// date-range scheduler. Multiple future "Yet to Start" trips on the same vehicle are fine.
async function assertVehicleTripAvailable(vehicleId, status, excludeTripId) {
  if (status !== 'On Trip') return null;
  const filter = { vehicle: vehicleId, status: 'On Trip', isDeleted: false };
  if (excludeTripId) filter._id = { $ne: excludeTripId };
  const clash = await Trip.findOne(filter);
  return clash ? 'This vehicle is already on another active trip' : null;
}

async function buildFilter({ search, status, minRating, startDate, endDate, vehicleId, customerId }) {
  const filter = { isDeleted: false };

  if (minRating) filter.rating = { $gte: minRating };
  if (search) {
    const regex = new RegExp(escapeRegex(search.trim()), 'i');
    const [matchingCustomers, matchingVehicles] = await Promise.all([
      Customer.find({ $or: [{ name: regex }, { mobile1: regex }, { mobile2: regex }] }, '_id'),
      Vehicle.find({ vehicleNo: regex }, '_id'),
    ]);
    filter.$or = [
      { tripId: regex },
      { customer: { $in: matchingCustomers.map((c) => c._id) } },
      { vehicle: { $in: matchingVehicles.map((v) => v._id) } },
    ];
  }
  if (status) filter.status = status;
  if (vehicleId) filter.vehicle = vehicleId;
  if (customerId) filter.customer = customerId;
  if (startDate || endDate) {
    filter.startDate = {};
    if (startDate) filter.startDate.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.startDate.$lte = end;
    }
  }

  return filter;
}

// GET /api/trips?search=&status=&page=&limit=&startDate=&endDate=
export const listTrips = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const page = req.query.page || 1;
  const limit = req.query.limit || 10;
  const filter = await buildFilter({
    search: req.query.search,
    status: req.query.status,
    minRating: req.query.minRating,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    vehicleId: req.query.vehicleId,
    customerId: req.query.customerId,
  });

  const [trips, total] = await Promise.all([
    Trip.find(filter)
      .populate('customer', CUSTOMER_POPULATE)
      .populate('vehicle', VEHICLE_POPULATE)
      .sort({ startDate: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Trip.countDocuments(filter),
  ]);

  res.status(200).json({
    data: trips,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    },
  });
});

// GET /api/trips/:id
export const getTrip = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id).populate('customer', CUSTOMER_POPULATE).populate('vehicle', VEHICLE_POPULATE);
  if (!trip) {
    return res.status(404).json({ message: 'Trip not found' });
  }
  res.status(200).json({ data: trip });
});

async function assertRefsActive(customerId, vehicleId) {
  const [customer, vehicle] = await Promise.all([
    Customer.findOne({ _id: customerId, isDeleted: false }),
    Vehicle.findOne({ _id: vehicleId, isDeleted: false }),
  ]);
  if (!customer) return 'Selected customer does not exist';
  if (!vehicle) return 'Selected vehicle does not exist';
  return null;
}

// POST /api/trips
export const createTrip = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const refError = await assertRefsActive(req.body.customer, req.body.vehicle);
  if (refError) return res.status(400).json({ message: refError });

  // Optional coupon. Eligibility is checked here so the client gets a clear message, and again
  // atomically when the usage is actually reserved below (two bookings racing for the last use).
  let couponDoc = null;
  let couponDiscount = 0;
  if (req.body.coupon) {
    couponDoc = await Coupon.findOne(applicableCouponFilter(req.body.customer, new Date(), req.body.coupon));
    if (!couponDoc) {
      return res.status(400).json({
        message: 'This coupon cannot be applied — it is inactive, expired, not valid for this customer, or has reached its usage limit',
      });
    }
    couponDiscount = calculateDiscount(couponDoc, req.body.amount);
  }
  // `amount` is stored net of the coupon discount, so balance due (amount - advance) stays correct
  // everywhere it's already computed.
  const netAmount = Math.max((Number(req.body.amount) || 0) - couponDiscount, 0);

  const businessError = checkBusinessRules({ ...req.body, amount: netAmount });
  if (businessError) return res.status(400).json({ message: businessError });

  // New trips always start life as "Yet to Start" — never accept an initial status from the
  // client, so there's no way to create a trip that's already On Trip/Completed/Cancelled.
  const {
    customer, vehicle, startDate, startTime, endDate, endTime,
    amount, tollCharges, advance, securityDeposit, startOdometer, endOdometer,
  } = req.body;

  const baseDoc = {
    customer,
    vehicle,
    startDate,
    startTime,
    endDate,
    endTime: endTime || '',
    amount: netAmount,
    tollCharges: tollCharges || 0,
    advance: advance || 0,
    securityDeposit: securityDeposit || 0,
    startOdometer: startOdometer === '' ? undefined : startOdometer,
    endOdometer: endOdometer === '' ? undefined : endOdometer,
    status: 'Yet to Start',
    ...(couponDoc ? { coupon: couponDoc._id, couponCode: couponDoc.code, couponDiscount } : {}),
    // rating only ever applies to a Completed trip — never accepted at creation time.
    // bookedDate is intentionally never taken from req.body — always "now" at creation.
  };

  // The pre-checked tripId from generateUniqueTripId is the common case; the retry here only
  // matters if another request generates and inserts the very same code in between our check
  // and our insert (E11000 on the unique index), which is astronomically unlikely but cheap to
  // handle correctly.
  // Reserve one use of the coupon first — a single atomic update that only succeeds while the
  // coupon is still live and under its maxUsage — and hand it back if the trip can't be created.
  let couponReserved = false;
  if (couponDoc) {
    const reserved = await Coupon.findOneAndUpdate(
      applicableCouponFilter(customer, new Date(), couponDoc._id),
      { $inc: { usageCount: 1 } }
    );
    if (!reserved) {
      return res.status(409).json({ message: 'This coupon has just reached its usage limit or is no longer valid' });
    }
    couponReserved = true;
  }

  let trip;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const tripId = await generateUniqueTripId();
      try {
        // eslint-disable-next-line no-await-in-loop
        trip = await Trip.create({ ...baseDoc, tripId });
        break;
      } catch (err) {
        if (err?.code === 11000 && err?.keyPattern?.tripId && attempt < 2) continue;
        throw err;
      }
    }
  } catch (err) {
    if (couponReserved) await Coupon.updateOne({ _id: couponDoc._id }, { $inc: { usageCount: -1 } });
    throw err;
  }
  await trip.populate([{ path: 'customer', select: CUSTOMER_POPULATE }, { path: 'vehicle', select: VEHICLE_POPULATE }]);

  res.status(201).json({ data: trip, message: 'Trip created successfully' });
});

// PUT/PATCH /api/trips/:id
//
// Trip lifecycle rules (see the 20-item spec this implements):
//  - Cancelled trips are frozen — no further edits at all.
//  - Completed trips only allow amount-related fields + rating to change.
//  - On Trip locks customer/vehicle/start date+time (reschedule is the only way to change
//    start date/time once under way) and tracks every end date/time change in endDateHistory.
//  - Transitioning TO Cancelled (from Yet to Start or On Trip) only accepts status +
//    refundAmount — every other field keeps its existing value, amount is zeroed (due = 0),
//    and refundAmount is capped at the trip's amount as it stood before cancellation.
//  - Rating can only ever be set once the resulting status is Completed.
export const updateTrip = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const existing = await Trip.findOne({ _id: req.params.id, isDeleted: false });
  if (!existing) {
    return res.status(404).json({ message: 'Trip not found' });
  }

  if (existing.status === 'Cancelled') {
    return res.status(400).json({ message: 'Cancelled trips cannot be edited' });
  }

  const requestedStatus = req.body.status;
  const allowedNextStatuses = ALLOWED_STATUS_TRANSITIONS[existing.status] || [];
  if (!allowedNextStatuses.includes(requestedStatus)) {
    return res.status(400).json({ message: `Cannot change trip status from "${existing.status}" to "${requestedStatus}"` });
  }

  // --- Cancellation: status + refundAmount only, everything else keeps its existing value ---
  if (requestedStatus === 'Cancelled' && existing.status !== 'Cancelled') {
    const originalAmount = Number(existing.amount) || 0;
    const originalAdvance = Number(existing.advance) || 0;
    // Only the advance already paid can come back — never more than that, and never more than
    // the trip amount either (in case advance was somehow left greater, e.g. legacy data).
    const maxRefund = Math.min(originalAdvance, originalAmount);
    const refundAmount = req.body.refundAmount === undefined || req.body.refundAmount === '' ? 0 : Number(req.body.refundAmount);
    if (refundAmount > maxRefund) {
      return res.status(400).json({ message: `Refund amount cannot be more than the advance paid (₹${maxRefund})` });
    }

    existing.status = 'Cancelled';
    existing.refundAmount = refundAmount;
    existing.amount = 0; // nothing further is due on a cancelled trip
    await existing.save();
    await existing.populate([{ path: 'customer', select: CUSTOMER_POPULATE }, { path: 'vehicle', select: VEHICLE_POPULATE }]);
    return res.status(200).json({ data: existing, message: 'Trip cancelled successfully' });
  }

  // --- Everything else: apply only the fields this status is allowed to change; every other
  // field keeps its existing stored value (reschedule is the only way to touch start date/time
  // once past "Yet to Start", and Completed only ever lets amount fields + rating move). ---
  const editableFields = EDITABLE_FIELDS_BY_STATUS[existing.status] || [];
  const ALL_TRIP_FIELDS = [
    'customer', 'vehicle', 'startDate', 'startTime', 'endDate', 'endTime',
    ...AMOUNT_FIELDS, 'startOdometer', 'endOdometer', 'rating',
  ];
  const next = {};
  for (const field of ALL_TRIP_FIELDS) {
    next[field] = editableFields.includes(field) && field in req.body ? req.body[field] : existing[field];
  }

  // A coupon can be added while editing (once — a coupon already on the trip can't be swapped
  // or removed). Eligibility is checked now for a clear error message and again atomically when the
  // usage is reserved below. The amount being saved is treated as the amount BEFORE the discount,
  // and is stored net of it, exactly like at creation.
  let couponDoc = null;
  let couponDiscount = 0;
  if (req.body.coupon) {
    if (existing.coupon) {
      if (String(existing.coupon) !== String(req.body.coupon)) {
        return res.status(400).json({ message: 'A coupon has already been applied to this trip and cannot be changed' });
      }
    } else {
      couponDoc = await Coupon.findOne(applicableCouponFilter(existing.customer, new Date(), req.body.coupon));
      if (!couponDoc) {
        return res.status(400).json({
          message: 'This coupon cannot be applied — it is inactive, expired, not valid for this customer, or has reached its usage limit',
        });
      }
      couponDiscount = calculateDiscount(couponDoc, next.amount);
    }
  }
  const netAmount = couponDoc ? Math.max((Number(next.amount) || 0) - couponDiscount, 0) : next.amount;

  const businessError = checkBusinessRules({
    status: requestedStatus,
    startDate: next.startDate?.toISOString?.().slice(0, 10) || next.startDate,
    startTime: next.startTime,
    endDate: next.endDate?.toISOString?.().slice(0, 10) || next.endDate,
    endTime: next.endTime,
    startOdometer: next.startOdometer,
    endOdometer: next.endOdometer,
    advance: next.advance,
    amount: netAmount,
  });
  if (businessError) return res.status(400).json({ message: businessError });

  if (String(next.customer) !== String(existing.customer) || String(next.vehicle) !== String(existing.vehicle)) {
    const refError = await assertRefsActive(next.customer, next.vehicle);
    if (refError) return res.status(400).json({ message: refError });
  }

  const lockError = await assertVehicleTripAvailable(next.vehicle, requestedStatus, req.params.id);
  if (lockError) return res.status(409).json({ message: lockError });

  // A trip can't be started (moved to "On Trip") until the customer's profile has been
  // verified as Accepted — which itself only happens once selfie, driving licence and Aadhaar
  // are on file (see customerController.updateCustomer). A trip can still be *created* for an
  // unverified customer; it just can't be started until their profile is Accepted.
  if (requestedStatus === 'On Trip' && existing.status !== 'On Trip') {
    const customerDoc = await Customer.findOne({ _id: next.customer, isDeleted: false });
    if (customerDoc?.profileVerified !== 'Accepted') {
      return res.status(400).json({
        message: "This customer's profile must be Accepted (selfie, driving licence and Aadhaar uploaded) before starting this trip",
      });
    }
  }

  // Rating only ever applies once the trip is Completed.
  existing.rating = requestedStatus === 'Completed' && next.rating ? next.rating : existing.rating;

  // Track every end date/time change made while a trip is On Trip (task: end date update history).
  if (existing.status === 'On Trip') {
    const newEndDate = next.endDate || undefined;
    const newEndTime = next.endTime || '';
    const endDateChanged = (existing.endDate ? existing.endDate.toISOString().slice(0, 10) : '') !== (newEndDate || '');
    const endTimeChanged = (existing.endTime || '') !== newEndTime;
    if (endDateChanged || endTimeChanged) {
      existing.endDateHistory.push({
        fromEndDate: existing.endDate,
        fromEndTime: existing.endTime,
        toEndDate: newEndDate,
        toEndTime: newEndTime,
        changedAt: new Date(),
      });
    }
  }

  existing.customer = next.customer;
  existing.vehicle = next.vehicle;
  existing.startDate = next.startDate;
  existing.startTime = next.startTime;
  existing.endDate = next.endDate || undefined;
  existing.endTime = next.endTime || '';
  existing.amount = netAmount ?? existing.amount ?? 0;
  existing.tollCharges = next.tollCharges ?? existing.tollCharges ?? 0;
  existing.advance = next.advance ?? existing.advance ?? 0;
  existing.securityDeposit = next.securityDeposit ?? existing.securityDeposit ?? 0;
  existing.startOdometer = next.startOdometer === '' ? undefined : next.startOdometer;
  existing.endOdometer = next.endOdometer === '' ? undefined : next.endOdometer;
  existing.status = requestedStatus;

  let couponReserved = false;
  if (couponDoc) {
    const reserved = await Coupon.findOneAndUpdate(
      applicableCouponFilter(existing.customer, new Date(), couponDoc._id),
      { $inc: { usageCount: 1 } }
    );
    if (!reserved) {
      return res.status(409).json({ message: 'This coupon has just reached its usage limit or is no longer valid' });
    }
    couponReserved = true;
    existing.coupon = couponDoc._id;
    existing.couponCode = couponDoc.code;
    existing.couponDiscount = couponDiscount;
  }

  try {
    await existing.save();
  } catch (err) {
    if (couponReserved) await Coupon.updateOne({ _id: couponDoc._id }, { $inc: { usageCount: -1 } });
    throw err;
  }
  await existing.populate([{ path: 'customer', select: CUSTOMER_POPULATE }, { path: 'vehicle', select: VEHICLE_POPULATE }]);

  res.status(200).json({ data: existing, message: 'Trip updated successfully' });
});

// POST /api/trips/:id/reschedule — the only way to change start date/time once a trip is past
// "Yet to Start"; the previous start date/time is preserved in rescheduleHistory, never lost.
export const rescheduleTrip = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const trip = await Trip.findOne({ _id: req.params.id, isDeleted: false });
  if (!trip) {
    return res.status(404).json({ message: 'Trip not found' });
  }
  if (trip.status === 'Completed' || trip.status === 'Cancelled') {
    return res.status(400).json({ message: `A ${trip.status.toLowerCase()} trip cannot be rescheduled` });
  }

  const { startDate, startTime } = req.body;

  // The new start can't land after the trip's end date/time.
  if (trip.endDate) {
    const endDay = trip.endDate.toISOString().slice(0, 10);
    const startDay = String(startDate).slice(0, 10);
    if (startDay > endDay) {
      return res.status(400).json({ message: 'New start date cannot be after the trip end date' });
    }
    if (startDay === endDay && trip.endTime && startTime > trip.endTime) {
      return res.status(400).json({ message: 'New start time cannot be after the trip end time on the same day' });
    }
  }

  trip.rescheduleHistory.push({
    fromStartDate: trip.startDate,
    fromStartTime: trip.startTime,
    toStartDate: startDate,
    toStartTime: startTime,
    rescheduledAt: new Date(),
  });
  trip.startDate = startDate;
  trip.startTime = startTime;

  await trip.save();
  await trip.populate([{ path: 'customer', select: CUSTOMER_POPULATE }, { path: 'vehicle', select: VEHICLE_POPULATE }]);

  res.status(200).json({ data: trip, message: 'Trip rescheduled successfully' });
});

// DELETE /api/trips/:id — soft delete
export const deleteTrip = asyncHandler(async (req, res) => {
  const trip = await Trip.findOneAndUpdate(
    { _id: req.params.id, isDeleted: false },
    { isDeleted: true },
    { new: true }
  );
  if (!trip) {
    return res.status(404).json({ message: 'Trip not found' });
  }
  res.status(200).json({ message: 'Trip deleted successfully' });
});

// GET /api/trips/stats?startDate=&endDate=
export const getStats = asyncHandler(async (req, res) => {
  const filter = await buildFilter({
    search: req.query.search,
    status: req.query.status,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  });

  const [summary] = await Trip.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        totalTrips: { $sum: 1 },
        totalAmount: { $sum: { $toDouble: '$amount' } },
        totalTollCharges: { $sum: { $toDouble: '$tollCharges' } },
        totalAdvance: { $sum: { $toDouble: '$advance' } },
        avgRating: { $avg: '$rating' },
      },
    },
  ]);

  const statusRows = await Trip.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
  const statusCounts = Object.fromEntries(statusRows.map((r) => [r._id, r.count]));

  res.status(200).json({
    data: {
      totalTrips: summary?.totalTrips || 0,
      totalAmount: summary?.totalAmount || 0,
      totalTollCharges: summary?.totalTollCharges || 0,
      totalAdvance: summary?.totalAdvance || 0,
      totalDue: (summary?.totalAmount || 0) - (summary?.totalAdvance || 0),
      avgRating: summary?.avgRating ? Math.round(summary.avgRating * 10) / 10 : 0,
      statusCounts: {
        'On Trip': statusCounts['On Trip'] || 0,
        'Yet to Start': statusCounts['Yet to Start'] || 0,
        Completed: statusCounts.Completed || 0,
        Cancelled: statusCounts.Cancelled || 0,
      },
    },
  });
});

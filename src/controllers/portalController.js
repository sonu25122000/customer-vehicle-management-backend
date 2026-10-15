import { body, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import CustomerDocument from '../models/CustomerDocument.js';
import Coupon from '../models/Coupon.js';
import Trip from '../models/Trip.js';
import Vehicle from '../models/Vehicle.js';
import VehiclePhoto from '../models/VehiclePhoto.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { recordCustomerHistory } from '../utils/customerHistory.js';
import { deactivateExpiredCoupons } from '../utils/couponRules.js';
import { documentSummary, syncProfileVerification } from '../utils/verification.js';
import { consumeTripOtp, OTP_LENGTH } from '../utils/tripOtp.js';
import { generateUniqueTripId } from './tripController.js';
import { storeCustomerDocuments } from './customerDocumentController.js';
import { publicCustomer } from './portalAuthController.js';

// Everything the customer site needs: the signed-in customer's profile, verification documents and
// trips, plus the public list of cars and offers. Responses never include anything only the business
// should see (vehicle owner details, admin notes, customer type, document files, trip OTPs).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Bookings are entered in the business's local time. Used to turn a date + time into an instant
// (for "can't start in the past" and the rental duration).
const BUSINESS_UTC_OFFSET = process.env.BUSINESS_UTC_OFFSET || '+05:30';
const MAX_BOOKING_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// Online booking from the customer site is switched off unless ENABLE_PORTAL_BOOKING=true — bookings
// are made by the team from the admin portal, and the site's "Book a Car" option is hidden to match.
const BOOKING_ENABLED = process.env.ENABLE_PORTAL_BOOKING === 'true';
// Customers upload these three; 'other' is admin-only.
const PORTAL_DOCUMENT_TYPES = ['aadhaar', 'drivingLicence', 'selfie'];
// Trips still holding the car — a new booking can't overlap any of these.
const ACTIVE_TRIP_STATUSES = ['Yet to Start', 'On Trip'];
const PHOTO_ORDER = ['front', 'passengerSide', 'driverSide', 'back', 'additional'];
const PUBLIC_VEHICLE_FIELDS = 'make model year vehicleType vehicleCategory transmission fuel pricePerDay';

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toInstant(date, time) {
  return new Date(`${date}T${time}:00${BUSINESS_UTC_OFFSET}`);
}

// Current business-local time as 'HH:mm'.
function businessTimeNow() {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(BUSINESS_UTC_OFFSET);
  const offsetMin = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  const local = new Date(Date.now() + offsetMin * 60 * 1000);
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
}

// Days charged for a rental: every started 24 hours counts as a day, minimum one.
export function rentalDays(start, end) {
  return Math.max(1, Math.ceil((end - start) / DAY_MS));
}

async function documentSummaries(customerId) {
  const documents = await CustomerDocument.find(
    { customer: customerId, isDeleted: false },
    'type status rejectionReason fileName uploadedBy createdAt reviewedAt'
  ).lean();
  return documents.map(documentSummary);
}

// ---------- Profile ----------

// GET /api/portal/profile
export const getProfile = asyncHandler(async (req, res) => {
  const customer = req.customer;
  const [documents, completedTrips, totalTrips] = await Promise.all([
    documentSummaries(customer._id),
    Trip.countDocuments({ customer: customer._id, isDeleted: false, status: 'Completed' }),
    Trip.countDocuments({ customer: customer._id, isDeleted: false }),
  ]);

  res.status(200).json({
    data: {
      ...publicCustomer(customer),
      documents,
      stats: { completedTrips, totalTrips },
    },
  });
});

export const profileValidators = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ max: 50 })
    .withMessage('Name cannot exceed 50 characters'),
  body('email').optional({ checkFalsy: true }).trim().isEmail().withMessage('Enter a valid email address').normalizeEmail({ gmail_remove_dots: false }),
];

// PATCH /api/portal/profile — name and email. The mobile number is the customer's login and can't be
// changed here. Every change is appended to the customer's edit history (CustomerHistory), which
// admins can see on the customer's record.
export const updateProfile = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const customer = req.customer;
  const { name, email, mobile1 } = req.body;
  if (mobile1 !== undefined && mobile1 !== customer.mobile1) {
    return res.status(400).json({ message: "Your mobile number can't be changed. Please contact us if it needs updating." });
  }

  const before = customer.toObject();
  customer.set({ name, email: email || '' });
  await customer.save();
  await recordCustomerHistory(before, customer, 'customer', customer.name);

  res.status(200).json({ data: publicCustomer(customer), message: 'Profile updated successfully' });
});

// ---------- Verification documents ----------

// POST /api/portal/documents (multipart: any of aadhaar / drivingLicence / selfie)
// A new upload replaces only that document type and puts only that document back to Pending review —
// documents already approved stay approved (the profile status is recomputed from all of them).
export const uploadDocuments = asyncHandler(async (req, res) => {
  const customer = req.customer;
  const files = req.files || {};
  const uploads = PORTAL_DOCUMENT_TYPES.filter((type) => files[type]?.[0]).map((type) => ({ type, file: files[type][0] }));
  if (!uploads.length) {
    return res.status(400).json({ message: 'Select at least one document to upload' });
  }

  await storeCustomerDocuments(customer, uploads, 'customer');
  const profileVerified = await syncProfileVerification(customer._id, 'customer', customer.name);

  res.status(200).json({
    data: { profileVerified, documents: await documentSummaries(customer._id) },
    message: 'Documents uploaded successfully',
  });
});

// ---------- Cars (public) ----------

async function photosByVehicle(vehicleIds) {
  const photos = await VehiclePhoto.find({ vehicle: { $in: vehicleIds }, isDeleted: false }, 'vehicle slot createdAt').lean();
  photos.sort((a, b) => PHOTO_ORDER.indexOf(a.slot) - PHOTO_ORDER.indexOf(b.slot) || a.createdAt - b.createdAt);
  const map = new Map();
  for (const p of photos) {
    const key = String(p.vehicle);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ _id: p._id, slot: p.slot });
  }
  return map;
}

// vehicleId -> { avg, count } of the ratings customers gave the car after their trips.
async function customerRatingsByVehicle(vehicleIds) {
  if (!vehicleIds.length) return new Map();
  const rows = await Trip.aggregate([
    { $match: { vehicle: { $in: vehicleIds }, isDeleted: false, customerRating: { $in: [1, 2, 3, 4, 5] } } },
    { $group: { _id: '$vehicle', avg: { $avg: '$customerRating' }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { avg: Math.round(r.avg * 10) / 10, count: r.count }]));
}

// Vehicle ids that already have a trip overlapping [startDate, endDate] (whole days).
function bookedVehicleIds(startDate, endDate, vehicleId) {
  const filter = {
    isDeleted: false,
    status: { $in: ACTIVE_TRIP_STATUSES },
    startDate: { $lte: new Date(endDate) },
    endDate: { $gte: new Date(startDate) },
  };
  if (vehicleId) filter.vehicle = vehicleId;
  return Trip.distinct('vehicle', filter);
}

export const vehicleListValidators = [
  query('startDate').optional({ checkFalsy: true }).matches(DATE_RE).withMessage('Invalid start date'),
  query('endDate').optional({ checkFalsy: true }).matches(DATE_RE).withMessage('Invalid end date'),
  query('search').optional({ checkFalsy: true }).trim().isLength({ max: 60 }).withMessage('Search is too long'),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).toInt(),
];

// GET /api/portal/vehicles?search=&limit=&startDate=&endDate= — Active cars, open to everyone (no login
// needed to browse). `search` matches make, model, type, category, fuel or transmission (every word
// has to match something, so "swift petrol" works); with dates, only cars free for them.
export const listVehicles = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const filter = { isDeleted: false, status: 'Active' };
  const { startDate, endDate, search, limit } = req.query;
  if (startDate && endDate) {
    const booked = await bookedVehicleIds(startDate, endDate);
    if (booked.length) filter._id = { $nin: booked };
  }
  const words = (search || '').split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length) {
    filter.$and = words.map((word) => {
      const regex = new RegExp(escapeRegex(word), 'i');
      return {
        $or: [
          { make: regex },
          { model: regex },
          { vehicleType: regex },
          { vehicleCategory: regex },
          { fuel: regex },
          { transmission: regex },
        ],
      };
    });
  }

  let cursor = Vehicle.find(filter, PUBLIC_VEHICLE_FIELDS).sort({ make: 1, model: 1 });
  if (limit) cursor = cursor.limit(limit);
  const vehicles = await cursor.lean();
  const ids = vehicles.map((v) => v._id);
  const [photos, ratings] = await Promise.all([photosByVehicle(ids), customerRatingsByVehicle(ids)]);
  res.status(200).json({
    data: vehicles.map((v) => ({
      ...v,
      photos: photos.get(String(v._id)) || [],
      rating: ratings.get(String(v._id)) || null,
    })),
  });
});

// GET /api/portal/vehicles/:id
export const getVehicle = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Car not found' });
  }
  const vehicle = await Vehicle.findOne({ _id: req.params.id, isDeleted: false, status: 'Active' }, PUBLIC_VEHICLE_FIELDS).lean();
  if (!vehicle) {
    return res.status(404).json({ message: 'Car not found' });
  }
  const [photos, ratings] = await Promise.all([photosByVehicle([vehicle._id]), customerRatingsByVehicle([vehicle._id])]);
  res.status(200).json({
    data: { ...vehicle, photos: photos.get(String(vehicle._id)) || [], rating: ratings.get(String(vehicle._id)) || null },
  });
});

// GET /api/portal/vehicle-photos/:id — the photo itself as an image (decoded from the stored data
// URI), so the site can use it directly in <img src> and the browser can cache it. Photos of Active
// cars are public; a signed-in customer can also see photos of any car from their own trips (so My
// Trips keeps its pictures even if that car is later taken off the site).
export const getVehiclePhotoImage = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).end();
  }
  const photo = await VehiclePhoto.findOne({ _id: req.params.id, isDeleted: false }, 'vehicle image mimeType').lean();
  if (!photo) {
    return res.status(404).end();
  }
  const isPublic = await Vehicle.exists({ _id: photo.vehicle, isDeleted: false, status: 'Active' });
  const isOwnTrip =
    !isPublic && req.customer && (await Trip.exists({ customer: req.customer._id, vehicle: photo.vehicle, isDeleted: false }));
  if (!isPublic && !isOwnTrip) {
    return res.status(404).end();
  }

  const match = /^data:([^;]+);base64,(.*)$/s.exec(photo.image || '');
  if (!match) {
    return res.status(404).end();
  }
  res.set('Content-Type', photo.mimeType || match[1]);
  res.set('Cache-Control', isPublic ? 'public, max-age=86400' : 'private, max-age=86400');
  res.send(Buffer.from(match[2], 'base64'));
});

// ---------- Offers (public) ----------

const OFFER_FIELDS = 'code discountType value maxDiscount applicability expiresAt';

// GET /api/portal/offers — coupons an admin marked "Show on customer site" that are live right now
// (active, inside their start/expiry window, not used up). Coupons for selected customers only appear
// for those customers, when they're signed in.
export const listOffers = asyncHandler(async (req, res) => {
  const now = new Date();
  await deactivateExpiredCoupons(now);
  const audience = req.customer
    ? [{ applicability: 'all' }, { applicability: 'selected', customers: req.customer._id }]
    : [{ applicability: 'all' }];
  const offers = await Coupon.find({
    isDeleted: false,
    isActive: true,
    isPublic: true,
    startAt: { $lte: now },
    expiresAt: { $gte: now },
    $and: [
      { $or: [{ maxUsage: { $exists: false } }, { maxUsage: null }, { $expr: { $lt: ['$usageCount', '$maxUsage'] } }] },
      { $or: audience },
    ],
  })
    .select(OFFER_FIELDS)
    .sort({ expiresAt: 1 })
    .limit(20)
    .lean();
  res.status(200).json({ data: offers.map((o) => ({ ...o, forYou: o.applicability === 'selected' })) });
});

// ---------- Trips ----------

const TRIP_VEHICLE_FIELDS = 'vehicleNo make model year vehicleType transmission fuel';
const PUBLIC_TRIP_FIELDS =
  'tripId vehicle startDate startTime endDate endTime amount advance securityDeposit refundAmount couponCode couponDiscount status bookedDate createdBy customerRating customerReview customerRatedAt startedAt endedAt';

// Adds the car's photo ids to each trip so My Trips can show what was booked.
async function withVehiclePhotos(trips) {
  const vehicleIds = [...new Set(trips.map((t) => t.vehicle?._id).filter(Boolean).map(String))];
  const photos = await photosByVehicle(vehicleIds.map((id) => new mongoose.Types.ObjectId(id)));
  return trips.map((t) => {
    const obj = t.toObject ? t.toObject() : t;
    if (obj.vehicle) obj.vehicle.photos = photos.get(String(obj.vehicle._id)) || [];
    return obj;
  });
}

function findOwnTrip(req, extraFields = '') {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Trip.findOne({ _id: req.params.id, customer: req.customer._id, isDeleted: false }).select(`${PUBLIC_TRIP_FIELDS} ${extraFields}`);
}

async function tripResponse(trip) {
  await trip.populate('vehicle', TRIP_VEHICLE_FIELDS);
  const [withPhotos] = await withVehiclePhotos([trip]);
  return withPhotos;
}

// GET /api/portal/trips — the signed-in customer's trips, newest first.
export const listTrips = asyncHandler(async (req, res) => {
  const trips = await Trip.find({ customer: req.customer._id, isDeleted: false }, PUBLIC_TRIP_FIELDS)
    .populate('vehicle', TRIP_VEHICLE_FIELDS)
    .sort({ startDate: -1, createdAt: -1 });
  res.status(200).json({ data: await withVehiclePhotos(trips) });
});

// GET /api/portal/trips/:id
export const getTrip = asyncHandler(async (req, res) => {
  const trip = await findOwnTrip(req);
  if (!trip) {
    return res.status(404).json({ message: 'Trip not found' });
  }
  res.status(200).json({ data: await tripResponse(trip) });
});

export const otpValidators = [
  body('otp')
    .trim()
    .matches(new RegExp(`^\\d{${OTP_LENGTH}}$`))
    .withMessage(`Enter the ${OTP_LENGTH}-digit OTP`),
];

// POST /api/portal/trips/:id/start { otp } — the customer starts their trip with the start OTP an
// admin shared. Needs a verified profile: until then the site sends the customer to upload/fix their
// documents instead (403 PROFILE_NOT_VERIFIED). Everything else is checked before the OTP is used up,
// so a valid code is never wasted on a request that would fail anyway.
export const startTrip = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const trip = await findOwnTrip(req, 'customer');
  if (!trip) {
    return res.status(404).json({ message: 'Trip not found' });
  }
  if (trip.status !== 'Yet to Start') {
    return res.status(400).json({ message: `This trip can't be started — it is ${trip.status.toLowerCase()}` });
  }
  if (req.customer.profileVerified !== 'Accepted') {
    return res.status(403).json({
      code: 'PROFILE_NOT_VERIFIED',
      profileVerified: req.customer.profileVerified,
      message:
        req.customer.profileVerified === 'Rejected'
          ? 'Some of your documents were rejected. Please upload them again to get your profile verified.'
          : 'Your profile needs to be verified before you can start a trip.',
    });
  }
  const carBusy = await Trip.exists({ _id: { $ne: trip._id }, vehicle: trip.vehicle, status: 'On Trip', isDeleted: false });
  if (carBusy) {
    return res.status(409).json({ message: 'This car is still on another trip. Please contact us.' });
  }

  const check = await consumeTripOtp(trip._id, 'start', req.body.otp);
  if (!check.ok) {
    return res.status(400).json({ message: check.message });
  }

  trip.status = 'On Trip';
  trip.startedAt = new Date();
  trip.startedBy = 'customer';
  await trip.save();
  res.status(200).json({ data: await tripResponse(trip), message: 'Your trip has started. Have a safe journey!' });
});

// POST /api/portal/trips/:id/end { otp } — the customer ends their trip with the end OTP an admin
// shared when the car is handed back. The planned end date/time is kept (an admin can adjust it and
// the odometer readings afterwards); endedAt records when it actually ended.
export const endTrip = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const trip = await findOwnTrip(req, 'customer');
  if (!trip) {
    return res.status(404).json({ message: 'Trip not found' });
  }
  if (trip.status !== 'On Trip') {
    return res.status(400).json({ message: `Only an ongoing trip can be ended — this one is ${trip.status.toLowerCase()}` });
  }

  const check = await consumeTripOtp(trip._id, 'end', req.body.otp);
  if (!check.ok) {
    return res.status(400).json({ message: check.message });
  }

  trip.status = 'Completed';
  trip.endedAt = new Date();
  trip.endedBy = 'customer';
  // A Completed trip needs an end time; trips booked without one get the actual end time.
  if (!trip.endTime) trip.endTime = businessTimeNow();
  await trip.save();
  res.status(200).json({ data: await tripResponse(trip), message: 'Trip completed. Thanks for riding with us!' });
});

export const ratingValidators = [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Choose a rating from 1 to 5 stars').toInt(),
  body('review').optional({ checkFalsy: true }).trim().isLength({ max: 500 }).withMessage('Review cannot exceed 500 characters'),
];

// POST /api/portal/trips/:id/rating { rating, review? } — after a Completed trip the customer rates the
// car (once). Kept separate from the admin's own trip rating.
export const rateTrip = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const trip = await findOwnTrip(req);
  if (!trip) {
    return res.status(404).json({ message: 'Trip not found' });
  }
  if (trip.status !== 'Completed') {
    return res.status(400).json({ message: 'You can rate the car once your trip is completed' });
  }
  if (trip.customerRating) {
    return res.status(409).json({ message: 'You have already rated this trip' });
  }

  trip.customerRating = req.body.rating;
  trip.customerReview = req.body.review || '';
  trip.customerRatedAt = new Date();
  await trip.save();
  res.status(200).json({ data: await tripResponse(trip), message: 'Thanks for rating your ride!' });
});

export const bookingValidators = [
  body('vehicle').isMongoId().withMessage('Select a car'),
  body('startDate').matches(DATE_RE).withMessage('Select a start date'),
  body('startTime').matches(TIME_RE).withMessage('Select a start time'),
  body('endDate').matches(DATE_RE).withMessage('Select an end date'),
  body('endTime').matches(TIME_RE).withMessage('Select an end time'),
];

// POST /api/portal/trips — book a car (only when ENABLE_PORTAL_BOOKING=true). The amount is always
// worked out here from the car's price per day (never taken from the request). The trip starts
// "Yet to Start" like any admin-created trip.
export const createBooking = asyncHandler(async (req, res) => {
  if (!BOOKING_ENABLED) {
    return res.status(403).json({ message: 'Online booking is not available. Please contact us to book a car.' });
  }
  if (!handleValidation(req, res)) return;

  const { vehicle: vehicleId, startDate, startTime, endDate, endTime } = req.body;
  const start = toInstant(startDate, startTime);
  const end = toInstant(endDate, endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return res.status(400).json({ message: 'Invalid start or end date' });
  }
  if (start < Date.now() - 5 * 60 * 1000) {
    return res.status(400).json({ message: 'The start date and time must be in the future' });
  }
  if (end <= start) {
    return res.status(400).json({ message: 'The end must be after the start' });
  }
  if (end - start > MAX_BOOKING_DAYS * DAY_MS) {
    return res.status(400).json({ message: `A booking can be at most ${MAX_BOOKING_DAYS} days long` });
  }

  const vehicle = await Vehicle.findOne({ _id: vehicleId, isDeleted: false, status: 'Active' });
  if (!vehicle) {
    return res.status(400).json({ message: 'This car is not available for booking' });
  }
  const clash = await bookedVehicleIds(startDate, endDate, vehicle._id);
  if (clash.length) {
    return res.status(409).json({ message: 'This car is already booked for some of those dates. Please pick other dates or another car.' });
  }

  const days = rentalDays(start, end);
  const amount = vehicle.pricePerDay ? days * vehicle.pricePerDay : 0;

  let trip;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tripId = await generateUniqueTripId();
    try {
      // eslint-disable-next-line no-await-in-loop
      trip = await Trip.create({
        tripId,
        customer: req.customer._id,
        vehicle: vehicle._id,
        startDate,
        startTime,
        endDate,
        endTime,
        amount,
        status: 'Yet to Start',
        createdBy: 'customer',
      });
      break;
    } catch (err) {
      if (err?.code === 11000 && err?.keyPattern?.tripId && attempt < 2) continue;
      throw err;
    }
  }

  await trip.populate('vehicle', TRIP_VEHICLE_FIELDS);
  res.status(201).json({ data: trip, days, message: 'Booking confirmed' });
});

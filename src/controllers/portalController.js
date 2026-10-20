import { body, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import CustomerDocument from '../models/CustomerDocument.js';
import Coupon from '../models/Coupon.js';
import Subscriber from '../models/Subscriber.js';
import Trip from '../models/Trip.js';
import Vehicle from '../models/Vehicle.js';
import VehiclePhoto from '../models/VehiclePhoto.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { recordCustomerHistory } from '../utils/customerHistory.js';
import {
  applicableCouponFilter,
  calculateDiscount,
  couponCodeProblem,
  couponsUsedUpBy,
  deactivateExpiredCoupons,
  minBookingProblem,
} from '../utils/couponRules.js';
import { documentSummary, syncProfileVerification } from '../utils/verification.js';
import { consumeTripOtp, ensureTripOtps, OTP_LENGTH } from '../utils/tripOtp.js';
import { objectKey, readFile, storeFile } from '../utils/storage.js';
import { customerProfilePhotoFileName, customerProfilePhotoKeyParts } from '../utils/fileNames.js';
import { generateUniqueTripId } from './tripController.js';
import { storeCustomerDocuments } from './customerDocumentController.js';
import { publicCustomer } from './portalAuthController.js';
import { firstNameAndInitial, publicTestimonials } from './testimonialController.js';
import { EMAIL_IN_USE, emailInUse } from '../utils/customerEmail.js';
import { EMAIL_OTP_LENGTH, respondWithEmailOtpError, sendEmailOtp, verifyEmailOtp } from '../utils/emailOtp.js';
import { sendEmail } from '../utils/email.js';
import { subscriberWelcomeEmail } from '../utils/emailTemplates.js';

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
// Customers upload these (Aadhaar front and back are separate); 'other' is admin-only.
const PORTAL_DOCUMENT_TYPES = ['aadhaar', 'aadhaarBack', 'drivingLicence', 'selfie'];
// Trips still holding the car — a new booking can't overlap any of these.
const ACTIVE_TRIP_STATUSES = ['Yet to Start', 'On Trip'];
const PHOTO_ORDER = ['front', 'passengerSide', 'driverSide', 'back', 'additional'];
const PUBLIC_VEHICLE_FIELDS = 'make model year vehicleType vehicleCategory transmission fuel pricePerDay pricePerHour parkingLocation';

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

const profileEmailValidator = body('email')
  .trim()
  .notEmpty()
  .withMessage('Email is required')
  .isLength({ max: 254 })
  .withMessage('Email is too long')
  .isEmail()
  .withMessage('Enter a valid email address')
  .normalizeEmail({ gmail_remove_dots: false });

const sameEmail = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

export const profileValidators = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ max: 50 })
    .withMessage('Name cannot exceed 50 characters'),
  profileEmailValidator,
  body('emailCode')
    .optional({ checkFalsy: true })
    .trim()
    .matches(new RegExp(`^[0-9]{${EMAIL_OTP_LENGTH}}$`))
    .withMessage(`Enter the ${EMAIL_OTP_LENGTH}-digit code we emailed you`),
];

export const profileEmailCodeValidators = [profileEmailValidator];

// POST /api/portal/profile/email-code { email } — changing the email, step 1: emails a 6-digit code to
// the NEW address (valid EMAIL_OTP_VALID_MINUTES). Nothing changes until it's entered (updateProfile).
export const sendProfileEmailCode = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const customer = req.customer;
  const { email } = req.body;
  if (sameEmail(email, customer.email)) {
    return res.status(400).json({ message: 'This is already your email address.' });
  }
  if (await emailInUse(email, customer._id)) {
    return res.status(409).json({ message: EMAIL_IN_USE, code: 'EMAIL_IN_USE' });
  }
  try {
    const { expiresAt, resendAt } = await sendEmailOtp({ email, purpose: 'change-email', customerId: customer._id, name: customer.name });
    res.status(200).json({ message: `We've sent a code to ${email}`, expiresAt, resendAt });
  } catch (err) {
    if (respondWithEmailOtpError(err, res)) return;
    throw err;
  }
});

// PATCH /api/portal/profile { name, email, emailCode? } — name and email. A new email needs the code
// sent to it by POST /profile/email-code (step 2 of changing the email); changing only the name doesn't.
// The mobile number is the customer's login and can't be changed here. Every change is appended to the
// customer's edit history (CustomerHistory), which admins can see on the customer's record.
export const updateProfile = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const customer = req.customer;
  const { name, email, mobile1 } = req.body;
  if (mobile1 !== undefined && mobile1 !== customer.mobile1) {
    return res.status(400).json({ message: "Your mobile number can't be changed. Please contact us if it needs updating." });
  }

  if (!sameEmail(email, customer.email)) {
    if (await emailInUse(email, customer._id)) {
      return res.status(409).json({ message: EMAIL_IN_USE, code: 'EMAIL_IN_USE' });
    }
    if (!req.body.emailCode) {
      return res.status(400).json({ message: 'Enter the code we emailed to your new address.', code: 'EMAIL_CODE_REQUIRED' });
    }
    try {
      await verifyEmailOtp({ email, purpose: 'change-email', customerId: customer._id, code: req.body.emailCode });
    } catch (err) {
      if (respondWithEmailOtpError(err, res)) return;
      throw err;
    }
  }

  const before = customer.toObject();
  customer.set({ name, email: email || '' });
  await customer.save();
  await recordCustomerHistory(before, customer, 'customer', customer.name);

  res.status(200).json({ data: publicCustomer(customer), message: 'Profile updated successfully' });
});

// POST /api/portal/profile/photo (multipart: photo) — the customer's profile picture (replaces the old one).
export const uploadProfilePhoto = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Choose a photo to upload' });
  }
  const customer = req.customer;
  const key = await storeFile(req.file, objectKey(...customerProfilePhotoKeyParts(customer, customerProfilePhotoFileName(customer, req.file))));
  customer.profilePhoto = { s3Key: key, mimeType: req.file.mimetype, updatedAt: new Date() };
  await customer.save();
  res.status(200).json({ data: publicCustomer(customer), message: 'Profile photo updated' });
});

// DELETE /api/portal/profile/photo — back to the initials avatar. (The file stays in the bucket.)
export const removeProfilePhoto = asyncHandler(async (req, res) => {
  const customer = req.customer;
  customer.profilePhoto = undefined;
  await customer.save();
  res.status(200).json({ data: publicCustomer(customer), message: 'Profile photo removed' });
});

// GET /api/portal/profile/photo — the signed-in customer's own picture, streamed from S3.
export const getProfilePhoto = asyncHandler(async (req, res) => {
  const file = req.customer.profilePhoto?.s3Key ? await readFile(req.customer.profilePhoto, 'image') : null;
  if (!file) {
    return res.status(404).end();
  }
  res.set('Content-Type', file.contentType);
  // The URL carries ?v=<photoVersion>, so a new upload is a new URL.
  res.set('Cache-Control', 'private, max-age=604800');
  res.send(file.body);
});

// ---------- Verification documents ----------

// POST /api/portal/documents (multipart: any of aadhaar / aadhaarBack / drivingLicence / selfie)
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

// GET /api/portal/documents/:id/file — one of the signed-in customer's own documents, streamed from S3
// so they can see what they uploaded.
export const getDocumentFile = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Document not found' });
  }
  const doc = await CustomerDocument.findOne({ _id: req.params.id, customer: req.customer._id, isDeleted: false }, 's3Key file mimeType fileName');
  const file = doc ? await readFile(doc, 'file') : null;
  if (!file) {
    return res.status(404).json({ message: 'Document not found' });
  }
  res.set('Content-Type', file.contentType);
  res.set('Content-Disposition', `inline; filename="${(doc.fileName || 'document').replace(/"/g, '')}"`);
  // A re-upload is a new document id, so the response for this id never changes.
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(file.body);
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

// Ratings the customers gave themselves on the site (customerRatedAt set) — older trips can carry a
// rating an admin gave, which the site doesn't show.
const CUSTOMER_RATED = { rating: { $in: [1, 2, 3, 4, 5] }, customerRatedAt: { $exists: true } };

// vehicleId -> { avg, count } of the ratings customers gave the car after their trips.
async function customerRatingsByVehicle(vehicleIds) {
  if (!vehicleIds.length) return new Map();
  const rows = await Trip.aggregate([
    { $match: { vehicle: { $in: vehicleIds }, isDeleted: false, ...CUSTOMER_RATED } },
    { $group: { _id: '$vehicle', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
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
// needed to browse). `search` matches make, model, type, category, fuel, transmission or parking location (every word
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
          { 'parkingLocation.address': regex },
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

// GET /api/portal/vehicles/:id/reviews — what customers said about this car after their trips ("Our
// Reviews" on the car's page), newest first. Only the customer's first name and initial are shown.
export const listVehicleReviews = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Car not found' });
  }
  const trips = await Trip.find(
    { vehicle: req.params.id, isDeleted: false, ...CUSTOMER_RATED },
    'rating customerReview customerRatedAt customer'
  )
    .populate('customer', 'name')
    .sort({ customerRatedAt: -1 })
    .limit(50)
    .lean();
  res.status(200).json({
    data: trips.map((t) => ({
      _id: t._id,
      rating: t.rating,
      review: t.customerReview || '',
      name: firstNameAndInitial(t.customer?.name),
      ratedAt: t.customerRatedAt,
    })),
  });
});

// GET /api/portal/testimonials — the home page reviews carousel (admin portal: "Home Carousel").
export const listTestimonials = asyncHandler(async (_req, res) => {
  res.status(200).json({ data: await publicTestimonials() });
});

// GET /api/portal/stats — headline numbers for the home page: cars on the site, completed trips and the
// customers' average rating.
export const getSiteStats = asyncHandler(async (_req, res) => {
  const [cars, completedTrips, [ratings]] = await Promise.all([
    Vehicle.countDocuments({ isDeleted: false, status: 'Active' }),
    Trip.countDocuments({ isDeleted: false, status: 'Completed' }),
    Trip.aggregate([
      { $match: { isDeleted: false, ...CUSTOMER_RATED } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]),
  ]);
  res.set('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    data: {
      cars,
      completedTrips,
      ratings: ratings?.count || 0,
      avgRating: ratings ? Math.round(ratings.avg * 10) / 10 : null,
    },
  });
});

// GET /api/portal/vehicle-photos/:id — the photo itself as an image (streamed from S3), so the site can
// use it directly in <img src> and the browser (and the CDN, for public cars) can cache it. Photos of Active
// cars are public; a signed-in customer can also see photos of any car from their own trips (so My
// Trips keeps its pictures even if that car is later taken off the site).
export const getVehiclePhotoImage = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).end();
  }
  const photo = await VehiclePhoto.findOne({ _id: req.params.id, isDeleted: false }, 'vehicle s3Key image mimeType').lean();
  if (!photo) {
    return res.status(404).end();
  }
  const isPublic = await Vehicle.exists({ _id: photo.vehicle, isDeleted: false, status: 'Active' });
  const isOwnTrip =
    !isPublic && req.customer && (await Trip.exists({ customer: req.customer._id, vehicle: photo.vehicle, isDeleted: false }));
  if (!isPublic && !isOwnTrip) {
    return res.status(404).end();
  }

  const file = await readFile(photo, 'image');
  if (!file) {
    return res.status(404).end();
  }
  res.set('Content-Type', file.contentType);
  // A photo id never changes content (a new upload is a new id), so it can be cached for a long time.
  res.set('Cache-Control', isPublic ? 'public, max-age=604800, immutable' : 'private, max-age=86400');
  res.send(file.body);
});

// ---------- Offers (public) ----------

const OFFER_FIELDS = 'code discountType value maxDiscount note minBookingAmount applicability expiresAt perCustomerLimit';

// GET /api/portal/offers — coupons an admin marked "Show on customer site" that are live right now
// (active, inside their start/expiry window, not used up). Coupons for selected customers are never
// listed here — they can't be made public (couponController), and older ones are filtered out too.
export const listOffers = asyncHandler(async (req, res) => {
  const now = new Date();
  await deactivateExpiredCoupons(now);
  const offers = await Coupon.find({
    isDeleted: false,
    isActive: true,
    isPublic: true,
    applicability: 'all',
    startAt: { $lte: now },
    expiresAt: { $gte: now },
    $or: [{ maxUsage: { $exists: false } }, { maxUsage: null }, { $expr: { $lt: ['$usageCount', '$maxUsage'] } }],
  })
    .select(OFFER_FIELDS)
    .sort({ expiresAt: 1 })
    .limit(20)
    .lean();
  // A signed-in customer doesn't see the coupons they've already used as often as each allows.
  const usedUp = await couponsUsedUpBy(offers, req.customer?._id);
  res.status(200).json({
    data: offers.filter((o) => !usedUp.has(String(o._id))),
  });
});

// ---------- Newsletter (public) ----------

export const subscribeValidators = [
  body('email').trim().notEmpty().withMessage('Enter your email address').isLength({ max: 254 }).withMessage('Email is too long').isEmail().withMessage('Enter a valid email address').normalizeEmail({ gmail_remove_dots: false }),
];

// A welcome email being sent is "claimed" for this long, so a double click doesn't send it twice; after
// that (e.g. the server stopped mid-send) a new subscribe may try again.
const WELCOME_CLAIM_MS = 5 * 60 * 1000;

// POST /api/portal/subscribe { email } — the home page's "Let us know your email" form. Subscribing an
// email that's already on the list just succeeds again (no duplicate record, nothing revealed). Every
// subscribe sends the welcome email (utils/email.js) — new and existing subscribers alike. If it can't be
// sent, the subscription still counts. (The route's rate limit caps how often one visitor can submit.)
export const subscribe = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { email } = req.body;
  await Subscriber.updateOne({ email }, { $setOnInsert: { email, source: 'home' } }, { upsert: true });

  const now = new Date();
  const claimed = await Subscriber.findOneAndUpdate(
    {
      email,
      $or: [{ welcomeClaimedAt: null }, { welcomeClaimedAt: { $lt: new Date(now - WELCOME_CLAIM_MS) } }],
    },
    { $set: { welcomeClaimedAt: now } }
  );
  if (claimed) {
    try {
      if (await sendEmail({ to: email, ...subscriberWelcomeEmail() })) {
        await Subscriber.updateOne({ email }, { $set: { welcomeSentAt: new Date() }, $unset: { welcomeClaimedAt: 1 } });
      } else {
        // Email isn't configured: leave it unsent, so it goes out once it is.
        await Subscriber.updateOne({ email }, { $unset: { welcomeClaimedAt: 1 } });
      }
    } catch (err) {
      console.error(`[email] Welcome email to ${email} failed: ${err.message}`);
      await Subscriber.updateOne({ email }, { $unset: { welcomeClaimedAt: 1 } });
    }
  }
  res.status(200).json({ message: 'Thanks for subscribing! Watch your inbox for offers.' });
});

// ---------- Trips ----------

const TRIP_VEHICLE_FIELDS = 'vehicleNo make model year vehicleType transmission fuel';
const PUBLIC_TRIP_FIELDS =
  'tripId vehicle startDate startTime endDate endTime amount advance securityDeposit refundAmount couponCode couponDiscount status bookedDate createdBy rating customerReview customerRatedAt startedAt endedAt';

// Adds the car's photo ids to each trip so My Trips can show what was booked. `rating` is only sent
// once the customer has rated the trip themselves (older trips may carry a rating an admin gave).
async function withVehiclePhotos(trips) {
  const vehicleIds = [...new Set(trips.map((t) => t.vehicle?._id).filter(Boolean).map(String))];
  const photos = await photosByVehicle(vehicleIds.map((id) => new mongoose.Types.ObjectId(id)));
  return trips.map((t) => {
    const obj = t.toObject ? t.toObject() : t;
    if (obj.vehicle) obj.vehicle.photos = photos.get(String(obj.vehicle._id)) || [];
    if (!obj.customerRatedAt) delete obj.rating;
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

// POST /api/portal/trips/:id/rating { rating, review? } — after a Completed trip the customer rates it
// (once). That one rating is the trip's rating and counts towards the car's rating; the review shows on
// the car's page on the site.
export const rateTrip = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const trip = await findOwnTrip(req);
  if (!trip) {
    return res.status(404).json({ message: 'Trip not found' });
  }
  if (trip.status !== 'Completed') {
    return res.status(400).json({ message: 'You can rate the car once your trip is completed' });
  }
  if (trip.customerRatedAt) {
    return res.status(409).json({ message: 'You have already rated this trip' });
  }

  trip.rating = req.body.rating;
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
  body('couponCode').optional({ checkFalsy: true }).trim().isLength({ max: 30 }).withMessage('Invalid coupon code'),
];

// The car and the price of a booking request, worked out here from the car's price per day (never
// taken from the request). Returns { error, status } or { vehicle, days, amount }.
async function priceBooking({ vehicle: vehicleId, startDate, startTime, endDate, endTime }) {
  const start = toInstant(startDate, startTime);
  const end = toInstant(endDate, endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { status: 400, error: 'Invalid start or end date' };
  }
  if (start < Date.now() - 5 * 60 * 1000) {
    return { status: 400, error: 'The start date and time must be in the future' };
  }
  if (end <= start) {
    return { status: 400, error: 'The end must be after the start' };
  }
  if (end - start > MAX_BOOKING_DAYS * DAY_MS) {
    return { status: 400, error: `A booking can be at most ${MAX_BOOKING_DAYS} days long` };
  }
  const vehicle = await Vehicle.findOne({ _id: vehicleId, isDeleted: false, status: 'Active' });
  if (!vehicle) {
    return { status: 400, error: 'This car is not available for booking' };
  }
  const days = rentalDays(start, end);
  return { vehicle, days, amount: vehicle.pricePerDay ? days * vehicle.pricePerDay : 0 };
}

// POST /api/portal/coupons/validate { code, vehicle, startDate, startTime, endDate, endTime } — checks a
// coupon code the customer typed in on the booking page and returns the discount it gives on that
// booking. Everything is checked here (code, dates, whether it's for this customer, usage left) —
// private coupons work too, they just aren't advertised. The booking itself checks again.
export const validateCoupon = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  if (!req.body.code?.trim()) {
    return res.status(400).json({ message: 'Enter a coupon code' });
  }
  const priced = await priceBooking(req.body);
  if (priced.error) return res.status(priced.status).json({ message: priced.error });

  await deactivateExpiredCoupons();
  const { coupon, message } = await couponCodeProblem(req.body.code, req.customer._id);
  if (!coupon) return res.status(400).json({ message });
  const belowMinimum = minBookingProblem(coupon, priced.amount);
  if (belowMinimum) return res.status(400).json({ message: belowMinimum });

  const discount = calculateDiscount(coupon, priced.amount);
  res.status(200).json({
    data: {
      code: coupon.code,
      discountType: coupon.discountType,
      value: coupon.value,
      maxDiscount: coupon.maxDiscount,
      amount: priced.amount,
      discount,
      payable: Math.max(priced.amount - discount, 0),
    },
    message: `${coupon.code} applied`,
  });
});

export const couponValidators = [...bookingValidators, body('code').optional().trim().isLength({ max: 30 }).withMessage('Invalid coupon code')];

// POST /api/portal/trips — book a car (only when ENABLE_PORTAL_BOOKING=true). The amount is always
// worked out here; an optional couponCode is checked and its use reserved here too. The trip starts
// "Yet to Start" like any admin-created trip, its booking source is Direct, and it gets its start/end
// OTPs straight away.
export const createBooking = asyncHandler(async (req, res) => {
  if (!BOOKING_ENABLED) {
    return res.status(403).json({ message: 'Online booking is not available. Please contact us to book a car.' });
  }
  if (!handleValidation(req, res)) return;

  const priced = await priceBooking(req.body);
  if (priced.error) return res.status(priced.status).json({ message: priced.error });
  const { vehicle, days, amount } = priced;
  const { startDate, startTime, endDate, endTime } = req.body;

  const clash = await bookedVehicleIds(startDate, endDate, vehicle._id);
  if (clash.length) {
    return res.status(409).json({ message: 'This car is already booked for some of those dates. Please pick other dates or another car.' });
  }

  let couponDoc = null;
  let couponDiscount = 0;
  if (req.body.couponCode) {
    await deactivateExpiredCoupons();
    const check = await couponCodeProblem(req.body.couponCode, req.customer._id);
    if (!check.coupon) return res.status(400).json({ message: check.message });
    const belowMinimum = minBookingProblem(check.coupon, amount);
    if (belowMinimum) return res.status(400).json({ message: belowMinimum });
    // Reserve one use atomically — only succeeds while the coupon is still live and under its limit.
    couponDoc = await Coupon.findOneAndUpdate(applicableCouponFilter(req.customer._id, new Date(), check.coupon._id), {
      $inc: { usageCount: 1 },
    });
    if (!couponDoc) {
      return res.status(409).json({ message: 'This coupon has just reached its usage limit or is no longer valid' });
    }
    couponDiscount = calculateDiscount(couponDoc, amount);
  }

  let trip;
  try {
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
          amount: Math.max(amount - couponDiscount, 0),
          status: 'Yet to Start',
          createdBy: 'customer',
          source: 'Direct',
          ...(couponDoc ? { coupon: couponDoc._id, couponCode: couponDoc.code, couponDiscount } : {}),
        });
        break;
      } catch (err) {
        if (err?.code === 11000 && err?.keyPattern?.tripId && attempt < 2) continue;
        throw err;
      }
    }
  } catch (err) {
    if (couponDoc) await Coupon.updateOne({ _id: couponDoc._id }, { $inc: { usageCount: -1 } });
    throw err;
  }

  await ensureTripOtps(trip, 'system');
  await trip.populate('vehicle', TRIP_VEHICLE_FIELDS);
  res.status(201).json({ data: trip, days, message: 'Booking confirmed' });
});

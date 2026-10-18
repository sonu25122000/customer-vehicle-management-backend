import { body, validationResult } from 'express-validator';
import Testimonial, { MAX_ACTIVE_TESTIMONIALS } from '../models/Testimonial.js';
import Trip from '../models/Trip.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// The customer site home page's reviews carousel (admin portal: "Home Carousel").

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

export const testimonialValidators = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 50 }).withMessage('Name cannot exceed 50 characters'),
  body('subtitle').optional({ checkFalsy: true }).trim().isLength({ max: 60 }).withMessage('Subtitle cannot exceed 60 characters'),
  body('text').trim().notEmpty().withMessage('Review text is required').isLength({ max: 500 }).withMessage('Review cannot exceed 500 characters'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5').toInt(),
  body('carName').optional({ checkFalsy: true }).trim().isLength({ max: 60 }).withMessage('Car name cannot exceed 60 characters'),
  body('trip').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid trip'),
  body('isActive').optional().isBoolean().withMessage('Invalid status').toBoolean(),
];

async function activeCount(excludeId) {
  const filter = { isDeleted: false, isActive: true };
  if (excludeId) filter._id = { $ne: excludeId };
  return Testimonial.countDocuments(filter);
}

const tooMany = `The carousel shows at most ${MAX_ACTIVE_TESTIMONIALS} reviews — hide one before showing another`;

// GET /api/testimonials — every slide, in carousel order.
export const listTestimonials = asyncHandler(async (_req, res) => {
  const data = await Testimonial.find({ isDeleted: false }).sort({ order: 1, createdAt: 1 }).lean();
  res.status(200).json({ data, maxActive: MAX_ACTIVE_TESTIMONIALS });
});

// GET /api/testimonials/reviews — customers' trip reviews (with text) that can be added to the
// carousel, best and newest first, flagged when already added.
export const listReviewCandidates = asyncHandler(async (_req, res) => {
  const [trips, used] = await Promise.all([
    Trip.find({ isDeleted: false, rating: { $in: [1, 2, 3, 4, 5] }, customerReview: { $nin: ['', null] } }, 'tripId rating customerReview customerRatedAt customer vehicle')
      .populate('customer', 'name')
      .populate('vehicle', 'make model')
      .sort({ rating: -1, customerRatedAt: -1 })
      .limit(50)
      .lean(),
    Testimonial.distinct('trip', { isDeleted: false, trip: { $exists: true } }),
  ]);
  const usedIds = new Set(used.map(String));
  res.status(200).json({
    data: trips.map((t) => ({
      _id: t._id,
      tripId: t.tripId,
      rating: t.rating,
      review: t.customerReview,
      ratedAt: t.customerRatedAt,
      customerName: t.customer?.name || 'Guest',
      carName: [t.vehicle?.make, t.vehicle?.model].filter(Boolean).join(' '),
      inCarousel: usedIds.has(String(t._id)),
    })),
  });
});

// POST /api/testimonials — added at the end of the carousel.
export const createTestimonial = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const isActive = req.body.isActive === undefined ? true : req.body.isActive;
  if (isActive && (await activeCount()) >= MAX_ACTIVE_TESTIMONIALS) {
    return res.status(400).json({ message: tooMany });
  }
  const last = await Testimonial.findOne({ isDeleted: false }).sort({ order: -1 }).lean();
  const { name, subtitle, text, rating, carName, trip } = req.body;
  const testimonial = await Testimonial.create({
    name,
    subtitle: subtitle || '',
    text,
    rating,
    carName: carName || '',
    trip: trip || undefined,
    isActive,
    order: (last?.order ?? -1) + 1,
  });
  res.status(201).json({ data: testimonial, message: 'Added to the carousel' });
});

// PUT /api/testimonials/:id
export const updateTestimonial = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const testimonial = await Testimonial.findOne({ _id: req.params.id, isDeleted: false });
  if (!testimonial) {
    return res.status(404).json({ message: 'Slide not found' });
  }
  const isActive = req.body.isActive === undefined ? testimonial.isActive : req.body.isActive;
  if (isActive && !testimonial.isActive && (await activeCount(testimonial._id)) >= MAX_ACTIVE_TESTIMONIALS) {
    return res.status(400).json({ message: tooMany });
  }
  const { name, subtitle, text, rating, carName } = req.body;
  testimonial.set({ name, subtitle: subtitle || '', text, rating, carName: carName || '', isActive });
  await testimonial.save();
  res.status(200).json({ data: testimonial, message: 'Slide updated' });
});

export const reorderValidators = [
  body('ids')
    .isArray({ min: 1 })
    .withMessage('Order is required')
    .custom((ids) => ids.every((id) => /^[0-9a-fA-F]{24}$/.test(id)))
    .withMessage('Invalid order'),
];

// PUT /api/testimonials/order { ids: [...] } — the carousel order, first slide first.
export const reorderTestimonials = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  await Testimonial.bulkWrite(
    req.body.ids.map((id, index) => ({ updateOne: { filter: { _id: id, isDeleted: false }, update: { $set: { order: index } } } }))
  );
  const data = await Testimonial.find({ isDeleted: false }).sort({ order: 1, createdAt: 1 }).lean();
  res.status(200).json({ data, message: 'Order saved' });
});

// DELETE /api/testimonials/:id — soft delete
export const deleteTestimonial = asyncHandler(async (req, res) => {
  const testimonial = await Testimonial.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, { isDeleted: true });
  if (!testimonial) {
    return res.status(404).json({ message: 'Slide not found' });
  }
  res.status(200).json({ message: 'Removed from the carousel' });
});

// How many of the latest customer reviews the home page carousel always leads with.
export const LATEST_REVIEWS_SHOWN = 5;

// Slides for the customer site: the LATEST_REVIEWS_SHOWN most recent reviews customers wrote after their
// trips (newest first; 4–5 stars with text), followed by the slides an admin pinned in the Home Carousel
// page (active ones, in their order), up to MAX_ACTIVE_TESTIMONIALS in all. New customer reviews show up
// on their own; a pinned review that's already among the latest isn't repeated.
export async function publicTestimonials() {
  const trips = await Trip.find(
    { isDeleted: false, rating: { $gte: 4 }, customerRatedAt: { $exists: true }, customerReview: { $nin: ['', null] } },
    'rating customerReview customerRatedAt customer vehicle'
  )
    .populate('customer', 'name')
    .populate('vehicle', 'make model')
    .sort({ customerRatedAt: -1 })
    .limit(LATEST_REVIEWS_SHOWN)
    .lean();
  const latest = trips.map((t) => ({
    _id: t._id,
    name: firstNameAndInitial(t.customer?.name),
    subtitle: '',
    text: t.customerReview,
    rating: t.rating,
    carName: [t.vehicle?.make, t.vehicle?.model].filter(Boolean).join(' '),
    ratedAt: t.customerRatedAt,
  }));

  const shownTrips = new Set(trips.map((t) => String(t._id)));
  const pinned = await Testimonial.find({ isDeleted: false, isActive: true })
    .sort({ order: 1, createdAt: 1 })
    .select('name subtitle text rating carName trip')
    .lean();
  const extra = pinned
    .filter((s) => !s.trip || !shownTrips.has(String(s.trip)))
    .slice(0, MAX_ACTIVE_TESTIMONIALS - latest.length)
    .map(({ trip, ...s }) => s);
  return [...latest, ...extra];
}

// "Ravi Kumar" -> "Ravi K." — customers' full names are never shown on the public site.
export function firstNameAndInitial(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Guest';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

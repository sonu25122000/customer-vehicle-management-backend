import mongoose from 'mongoose';

export const TRIP_SOURCES = ['Direct', 'Zoomcar'];

const decimalGetter = (v) => (v !== undefined && v !== null ? parseFloat(v.toString()) : v);

const tripSchema = new mongoose.Schema(
  {
    // Human-meaningful booking reference, e.g. RW0926AXYZ — RW (Roam Wheels) + booking month/year
    // + a 4-character random code. Generated server-side in tripController.buildTripId, never
    // accepted from the request body. Uniqueness is enforced by the index below; createTrip
    // retries generation on the rare collision.
    tripId: {
      type: String,
      required: true,
      unique: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: [true, 'Guest is required'],
    },
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle',
      required: [true, 'Vehicle is required'],
    },
    startDate: {
      type: Date,
      required: [true, 'Start date is required'],
    },
    startTime: {
      type: String,
      required: [true, 'Start time is required'],
      trim: true,
    },
    endDate: {
      type: Date,
      required: [true, 'End date is required'],
    },
    endTime: {
      type: String,
      trim: true,
      default: '',
    },
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      default: 0,
      get: decimalGetter,
    },
    tollCharges: {
      type: mongoose.Schema.Types.Decimal128,
      default: 0,
      get: decimalGetter,
    },
    // Paid upfront at booking time — the remaining balance (amount - advance) is computed on
    // read, not stored separately.
    advance: {
      type: mongoose.Schema.Types.Decimal128,
      default: 0,
      get: decimalGetter,
    },
    securityDeposit: {
      type: mongoose.Schema.Types.Decimal128,
      default: 0,
      get: decimalGetter,
    },
    // Only meaningful once status is Cancelled — disabled on the form otherwise. Capped at
    // the trip's amount at the moment of cancellation (see tripController.updateTrip).
    refundAmount: {
      type: mongoose.Schema.Types.Decimal128,
      default: 0,
      get: decimalGetter,
    },
    // Coupon redeemed at booking time (optional). couponCode/couponDiscount are snapshots so the
    // trip keeps showing what was applied even if the coupon is later edited or deleted. `amount`
    // above is already the NET payable amount after couponDiscount was taken off — set once in
    // tripController.createTrip, never accepted from the request body.
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Coupon',
    },
    couponCode: {
      type: String,
      trim: true,
    },
    couponDiscount: {
      type: mongoose.Schema.Types.Decimal128,
      default: 0,
      get: decimalGetter,
    },
    startOdometer: {
      type: Number,
      min: 0,
    },
    endOdometer: {
      type: Number,
      min: 0,
    },
    status: {
      type: String,
      enum: ['On Trip', 'Yet to Start', 'Completed', 'Cancelled'],
      default: 'Yet to Start',
    },
    // Set once, server-side, at creation time — never accepted from the request body.
    bookedDate: {
      type: Date,
      default: Date.now,
    },
    // 'admin' for trips created from the admin portal, 'customer' for bookings made on the
    // customer site — same convention as Customer.createdBy. Set server-side only.
    createdBy: {
      type: String,
      enum: ['admin', 'customer'],
      default: 'admin',
    },
    // Where the booking came from: booked with us directly (always the case for bookings made on the
    // customer site), or through Zoomcar.
    source: {
      type: String,
      enum: TRIP_SOURCES,
      default: 'Direct',
    },
    // The trip's one rating: given by the customer on the customer site once the trip is Completed
    // (portalController.rateTrip), with an optional review (customerReview). It rates the trip and the
    // car together — it rolls up into the vehicle's average rating and the car's reviews on the site.
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: undefined,
    },
    // Legacy: the customer's separate vehicle rating from when trips had two ratings. Copied into
    // `rating` at startup (app.js) and no longer written.
    customerRating: {
      type: Number,
      min: 1,
      max: 5,
      default: undefined,
    },
    customerReview: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    customerRatedAt: {
      type: Date,
    },
    // When the trip actually started / ended, and from where: 'admin' when the status was changed in
    // the admin portal (no OTP needed), 'customer' when the customer did it on the customer site with
    // the OTP an admin shared (see models/TripOtp.js).
    startedAt: { type: Date },
    startedBy: { type: String, enum: ['admin', 'customer'] },
    endedAt: { type: Date },
    endedBy: { type: String, enum: ['admin', 'customer'] },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    // Every reschedule (start date/time change) is appended here rather than overwriting —
    // the old start date/time is never mutated outside this history trail (see task: keep
    // reschedule history). Populated only via POST /api/trips/:id/reschedule.
    rescheduleHistory: {
      type: [
        {
          _id: false,
          fromStartDate: Date,
          fromStartTime: String,
          toStartDate: Date,
          toStartTime: String,
          rescheduledAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    // Every end date/time change made once a trip is On Trip is appended here — see
    // tripController.updateTrip.
    endDateHistory: {
      type: [
        {
          _id: false,
          fromEndDate: Date,
          fromEndTime: String,
          toEndDate: Date,
          toEndTime: String,
          changedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true, virtuals: false },
    toObject: { getters: true, virtuals: false },
  }
);

// Last line of defence for the odometer rule, whichever code path saves the trip (admin edit, the
// customer ending the trip, ...). tripController.checkBusinessRules gives the friendlier 400 first.
tripSchema.pre('validate', function checkOdometer(next) {
  const start = this.startOdometer;
  const end = this.endOdometer;
  if (end !== undefined && end !== null) {
    if (start === undefined || start === null) {
      this.invalidate('endOdometer', 'Enter the starting odometer reading before the ending reading');
    } else if (end < start) {
      this.invalidate('endOdometer', 'Ending odometer reading cannot be less than the starting reading');
    }
  }
  next();
});

tripSchema.index({ customer: 1, isDeleted: 1, startDate: -1 });
tripSchema.index({ vehicle: 1, isDeleted: 1, status: 1 });
tripSchema.index({ status: 1, isDeleted: 1 });
tripSchema.index({ isDeleted: 1 });

export default mongoose.model('Trip', tripSchema);

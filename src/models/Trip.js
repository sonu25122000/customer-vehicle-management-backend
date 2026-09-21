import mongoose from 'mongoose';

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
      required: [true, 'Customer is required'],
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
    // The only rating in the Trip/Vehicle relationship — rolls up into the vehicle's
    // average rating (see vehicleController's aggregation). There is no separate
    // vehicle-only rating field.
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: undefined,
    },
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

tripSchema.index({ customer: 1, isDeleted: 1, startDate: -1 });
tripSchema.index({ vehicle: 1, isDeleted: 1, status: 1 });
tripSchema.index({ status: 1, isDeleted: 1 });
tripSchema.index({ isDeleted: 1 });

export default mongoose.model('Trip', tripSchema);

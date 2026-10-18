import mongoose from 'mongoose';

// Reporting tables, filled by the nightly report engine (utils/reportEngine.js) — never written by the
// rest of the app. They start empty; each run computes one metric at a time and writes it in.
//
// A trip counts towards the day (and so the month and year) it STARTS on: a trip from 30 Sept to 2 Oct
// is one September trip, with all of its amount in September.
//
//   DailyReport   one row per day     key 'YYYY-MM-DD'
//   MonthlyReport one row per month   key 'YYYY-MM'
//   YearlyReport  one row per year    key 'YYYY'
//
// Custom date ranges are worked out on request from the trips themselves (reportController.custom).

export const REPORT_METRICS = [
  { key: 'totalTrips', label: 'Total Trips' },
  { key: 'completedTrips', label: 'Completed' },
  { key: 'cancelledTrips', label: 'Cancelled' },
  { key: 'amount', label: 'Amount' },
  { key: 'toll', label: 'Toll' },
  { key: 'newCustomers', label: 'New Guests' },
  { key: 'repeatCustomers', label: 'Repeat Guests' },
  { key: 'vehicleExpense', label: 'Vehicle Expense' },
  { key: 'directBookings', label: 'Direct Bookings' },
  { key: 'thirdPartyBookings', label: 'Third Party Bookings' },
];

function reportSchema() {
  const metricFields = Object.fromEntries(REPORT_METRICS.map((m) => [m.key, { type: Number, default: 0 }]));
  const schema = new mongoose.Schema(
    {
      // 'YYYY-MM-DD', 'YYYY-MM' or 'YYYY' — see above.
      key: { type: String, required: true },
      from: { type: Date, required: true },
      to: { type: Date, required: true },
      ...metricFields,
      // Last time each metric was written, by metric key.
      computedAt: { type: Map, of: Date, default: {} },
      lastJob: { type: mongoose.Schema.Types.ObjectId, ref: 'ReportJob' },
    },
    { timestamps: true }
  );
  schema.index({ key: 1 }, { unique: true });
  return schema;
}

export const DailyReport = mongoose.model('DailyReport', reportSchema());
export const MonthlyReport = mongoose.model('MonthlyReport', reportSchema());
export const YearlyReport = mongoose.model('YearlyReport', reportSchema());

// One row per run of the report engine — what the admin portal's Job History tab lists.
const stepSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['daily', 'monthly', 'yearly'], required: true },
    metric: { type: String, required: true },
    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: '' },
    finishedAt: { type: Date },
  },
  { _id: false }
);

const reportJobSchema = new mongoose.Schema(
  {
    // The business day the run is for, 'YYYY-MM-DD' (its month and year are refreshed too).
    date: { type: String, required: true },
    trigger: { type: String, enum: ['schedule', 'manual', 'retry'], required: true },
    triggeredBy: { type: String, default: '' },
    status: { type: String, enum: ['running', 'success', 'failed'], default: 'running' },
    steps: { type: [stepSchema], default: [] },
    // First error of the run, for the history table.
    error: { type: String, default: '' },
    maxRetries: { type: Number, default: 5 },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
    durationMs: { type: Number },
    // Set on a run started with "Retry": the failed run it retried.
    retryOf: { type: mongoose.Schema.Types.ObjectId, ref: 'ReportJob' },
    // Set on a failed run once it has been retried, to the run that retried it.
    retriedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'ReportJob' },
  },
  { timestamps: true }
);

reportJobSchema.index({ startedAt: -1 });
reportJobSchema.index({ date: 1, status: 1 });

export const ReportJob = mongoose.model('ReportJob', reportJobSchema);

import Trip from '../models/Trip.js';
import VehicleExpense from '../models/VehicleExpense.js';
import { DailyReport, MonthlyReport, YearlyReport, ReportJob, REPORT_METRICS } from '../models/Report.js';

// The report engine. Runs every night (Vercel Cron in production — see vercel.json and
// reportController.cron; an in-process timer when the API runs as a normal server — see
// startReportScheduler) for the business day that just ended, and can be run by hand from the admin
// portal's Reports page.
//
// One run = one ReportJob. It refreshes that day's DailyReport row and the MonthlyReport / YearlyReport
// rows the day falls in, ONE METRIC AT A TIME: each metric is computed and written on its own, so one
// failing metric doesn't lose the others. A failing metric is retried automatically, up to
// REPORT_MAX_RETRIES times (default 5) with a short back-off; if it still fails, the run ends 'failed'
// with the error, and the admin portal's Job History tab offers a Retry.
//
// Dates: trips count towards the day they START on (Trip.startDate is the calendar date at 00:00 UTC),
// so a trip from 30 Sept to 2 Oct is a September trip with all of its amount in September.

const BUSINESS_UTC_OFFSET = process.env.BUSINESS_UTC_OFFSET || '+05:30';
const DAY_MS = 24 * 60 * 60 * 1000;
// Automatic retries per metric. Configurable, never more than 5 (and at least 0).
export const MAX_RETRIES = Math.min(Math.max(Number(process.env.REPORT_MAX_RETRIES ?? 5) || 0, 0), 5);
const RETRY_BASE_DELAY_MS = Number(process.env.REPORT_RETRY_DELAY_MS) || 500;
// A run stuck in 'running' this long (e.g. the serverless function was killed) counts as failed.
const STALE_RUN_MS = 15 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function offsetMinutes() {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(BUSINESS_UTC_OFFSET);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

// Today's business date as 'YYYY-MM-DD', shifted by `days`.
export function businessDate(days = 0, now = new Date()) {
  return new Date(now.getTime() + offsetMinutes() * 60 * 1000 + days * DAY_MS).toISOString().slice(0, 10);
}

export function isValidDate(value) {
  return DATE_RE.test(value || '') && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

// The calendar ranges a day falls in, as [from, to) UTC-midnight instants (the same form trip start
// dates and expense dates are stored in).
export function rangesFor(date) {
  const day = new Date(`${date}T00:00:00Z`);
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  return {
    daily: { key: date, from: day, to: new Date(day.getTime() + DAY_MS) },
    monthly: { key: date.slice(0, 7), from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 1)) },
    yearly: { key: date.slice(0, 4), from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1)) },
  };
}

const SCOPES = { daily: DailyReport, monthly: MonthlyReport, yearly: YearlyReport };

// ---- Metrics. Each takes a [from, to) range and returns a number. ----

// Trips starting in the range. Cancelled trips only count towards cancelledTrips.
function tripsIn({ from, to }, extra = {}) {
  return { isDeleted: false, startDate: { $gte: from, $lt: to }, ...extra };
}
const notCancelled = { status: { $ne: 'Cancelled' } };

async function sumTrips(range, field) {
  const [row] = await Trip.aggregate([
    { $match: tripsIn(range, notCancelled) },
    { $group: { _id: null, total: { $sum: { $toDouble: { $ifNull: [`$${field}`, 0] } } } } },
  ]);
  return Math.round((row?.total || 0) * 100) / 100;
}

// Customers with a (non-cancelled) trip starting in the range, split by whether their very first trip
// starts in the range (new) or before it (repeat).
async function customerSplit(range) {
  const customers = await Trip.distinct('customer', tripsIn(range, notCancelled));
  if (!customers.length) return { newCustomers: 0, repeatCustomers: 0 };
  const repeat = await Trip.distinct('customer', {
    isDeleted: false,
    ...notCancelled,
    customer: { $in: customers },
    startDate: { $lt: range.from },
  });
  return { newCustomers: customers.length - repeat.length, repeatCustomers: repeat.length };
}

export const METRIC_FUNCTIONS = {
  totalTrips: (range) => Trip.countDocuments(tripsIn(range, notCancelled)),
  completedTrips: (range) => Trip.countDocuments(tripsIn(range, { status: 'Completed' })),
  cancelledTrips: (range) => Trip.countDocuments(tripsIn(range, { status: 'Cancelled' })),
  amount: (range) => sumTrips(range, 'amount'),
  toll: (range) => sumTrips(range, 'tollCharges'),
  newCustomers: async (range) => (await customerSplit(range)).newCustomers,
  repeatCustomers: async (range) => (await customerSplit(range)).repeatCustomers,
  vehicleExpense: async ({ from, to }) => {
    const [row] = await VehicleExpense.aggregate([
      { $match: { isDeleted: false, date: { $gte: from, $lt: to } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return Math.round((row?.total || 0) * 100) / 100;
  },
  directBookings: (range) => Trip.countDocuments(tripsIn(range, { ...notCancelled, source: { $ne: 'Zoomcar' } })),
  thirdPartyBookings: (range) => Trip.countDocuments(tripsIn(range, { ...notCancelled, source: 'Zoomcar' })),
};

// Every metric for any range, computed live (the Custom range report).
export async function computeRange(range) {
  const values = await Promise.all(REPORT_METRICS.map((m) => METRIC_FUNCTIONS[m.key](range)));
  return Object.fromEntries(REPORT_METRICS.map((m, i) => [m.key, values[i]]));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Computes one metric for one scope and writes it into that scope's report row, retrying on failure.
// Resolves to { ok, attempts, error }.
async function runStep(job, scope, range, metric) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const value = await METRIC_FUNCTIONS[metric](range);
      // eslint-disable-next-line no-await-in-loop
      await SCOPES[scope].updateOne(
        { key: range.key },
        {
          $set: { [metric]: value, [`computedAt.${metric}`]: new Date(), lastJob: job._id },
          $setOnInsert: { from: range.from, to: range.to },
        },
        { upsert: true }
      );
      return { ok: true, attempts: attempt };
    } catch (err) {
      lastError = err;
      // eslint-disable-next-line no-await-in-loop
      if (attempt <= MAX_RETRIES) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  return { ok: false, attempts: MAX_RETRIES + 1, error: lastError?.message || String(lastError) };
}

// Runs the report engine for one business day. Resolves to the finished ReportJob.
export async function runReportJob(date, { trigger = 'manual', triggeredBy = '', retryOf } = {}) {
  if (!isValidDate(date)) throw new Error(`Invalid report date: ${date}`);

  // Runs left 'running' by a process that died never finish — mark them failed so they can be retried.
  await ReportJob.updateMany(
    { status: 'running', startedAt: { $lt: new Date(Date.now() - STALE_RUN_MS) } },
    { $set: { status: 'failed', error: 'The run stopped before finishing (timed out or the server restarted)', finishedAt: new Date() } }
  );
  const running = await ReportJob.findOne({ date, status: 'running' });
  if (running) {
    const err = new Error(`A report run for ${date} is already in progress`);
    err.status = 409;
    throw err;
  }

  const ranges = rangesFor(date);
  const job = await ReportJob.create({
    date,
    trigger,
    triggeredBy,
    retryOf,
    maxRetries: MAX_RETRIES,
    steps: Object.keys(SCOPES).flatMap((scope) => REPORT_METRICS.map((m) => ({ scope, metric: m.key }))),
  });
  if (retryOf) await ReportJob.updateOne({ _id: retryOf }, { $set: { retriedBy: job._id } });

  // One metric at a time, saving progress after each so the history shows where a run got to.
  for (let i = 0; i < job.steps.length; i++) {
    const step = job.steps[i];
    // eslint-disable-next-line no-await-in-loop
    const result = await runStep(job, step.scope, ranges[step.scope], step.metric);
    step.status = result.ok ? 'success' : 'failed';
    step.attempts = result.attempts;
    step.error = result.error || '';
    step.finishedAt = new Date();
    if (!result.ok && !job.error) job.error = `${step.scope} ${step.metric}: ${result.error}`;
    // eslint-disable-next-line no-await-in-loop
    await ReportJob.updateOne({ _id: job._id }, { $set: { [`steps.${i}`]: step.toObject(), error: job.error } });
  }

  job.status = job.steps.every((s) => s.status === 'success') ? 'success' : 'failed';
  job.finishedAt = new Date();
  job.durationMs = job.finishedAt - job.startedAt;
  await job.save();
  if (job.status === 'failed') console.error(`Report run for ${date} failed: ${job.error}`);
  return job;
}

// The nightly run: the business day that just ended (plus REPORT_LOOKBACK_DAYS - 1 days before it, to
// pick up trips that were completed or edited afterwards — default 1, just that day).
export async function runNightlyReports() {
  const days = Math.min(Math.max(Number(process.env.REPORT_LOOKBACK_DAYS) || 1, 1), 31);
  // Run just after midnight, "the day that just ended" is yesterday's business date.
  const jobs = [];
  for (let back = days; back >= 1; back--) {
    // eslint-disable-next-line no-await-in-loop
    jobs.push(await runReportJob(businessDate(-back), { trigger: 'schedule', triggeredBy: 'scheduler' }));
  }
  return jobs;
}

// When the API runs as a long-lived server (local / VM — not Vercel, where vercel.json's cron calls
// GET /api/reports/cron instead): runs the nightly reports every day at REPORT_RUN_TIME business time
// ('HH:mm', default '00:05'). REPORT_SCHEDULER=off turns it off.
export function startReportScheduler() {
  if (process.env.REPORT_SCHEDULER === 'off') return;
  const [h, m] = (/^([01]\d|2[0-3]):([0-5]\d)$/.exec(process.env.REPORT_RUN_TIME || '00:05') || [null, '00', '05']).slice(1).map(Number);

  function msUntilNextRun() {
    const nowLocal = Date.now() + offsetMinutes() * 60 * 1000;
    const todayRun = Math.floor(nowLocal / DAY_MS) * DAY_MS + (h * 60 + m) * 60 * 1000;
    return (todayRun > nowLocal ? todayRun : todayRun + DAY_MS) - nowLocal;
  }
  function schedule() {
    const timer = setTimeout(async () => {
      try {
        await runNightlyReports();
      } catch (err) {
        console.error('Nightly reports failed:', err.message);
      }
      schedule();
    }, msUntilNextRun());
    timer.unref?.();
  }
  schedule();
  console.log(`Report engine scheduled daily at ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} (${BUSINESS_UTC_OFFSET})`);
}

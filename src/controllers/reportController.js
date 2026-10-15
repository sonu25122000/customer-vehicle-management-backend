import crypto from 'crypto';
import { body, query, validationResult } from 'express-validator';
import { DailyReport, MonthlyReport, YearlyReport, ReportJob, REPORT_METRICS } from '../models/Report.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { businessDate, computeRange, isValidDate, MAX_RETRIES, runNightlyReports, runReportJob } from '../utils/reportEngine.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Most days one "Run now" request may cover — each day is a full run, and the request has to finish
// within the hosting platform's time limit.
const MAX_RUN_DAYS = 31;
const MAX_CUSTOM_DAYS = 366 * 3;

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

const dateParam = (name, where = query) =>
  where(name).custom((v) => isValidDate(v)).withMessage(`${name === 'from' ? 'Start' : 'End'} date must be a valid date`);

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

const metricsMeta = REPORT_METRICS.map(({ key, label }) => ({ key, label }));

// GET /api/reports/daily?from=&to= — day rows (default: the last 30 days), newest first.
export const dailyValidators = [dateParam('from').optional({ checkFalsy: true }), dateParam('to').optional({ checkFalsy: true })];
export const listDaily = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const to = req.query.to || businessDate();
  const from = req.query.from || businessDate(-29, new Date(`${to}T12:00:00Z`));
  if (from > to) return res.status(400).json({ message: 'Start date must be on or before the end date' });
  const data = await DailyReport.find({ key: { $gte: from, $lte: to } }).sort({ key: -1 }).limit(400).lean();
  res.status(200).json({ data, metrics: metricsMeta, from, to });
});

// GET /api/reports/monthly?year=YYYY — month rows of a year (default: this year).
export const monthlyValidators = [query('year').optional({ checkFalsy: true }).matches(/^\d{4}$/).withMessage('Invalid year')];
export const listMonthly = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const year = req.query.year || businessDate().slice(0, 4);
  const data = await MonthlyReport.find({ key: new RegExp(`^${year}-`) }).sort({ key: -1 }).lean();
  res.status(200).json({ data, metrics: metricsMeta, year });
});

// GET /api/reports/yearly — every year row.
export const listYearly = asyncHandler(async (_req, res) => {
  const data = await YearlyReport.find().sort({ key: -1 }).lean();
  res.status(200).json({ data, metrics: metricsMeta });
});

// GET /api/reports/custom?from=&to= — every metric for any date range, worked out live from the trips
// (trips counted by start date), so it's always up to date.
export const customValidators = [dateParam('from'), dateParam('to')];
export const customReport = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { from, to } = req.query;
  if (from > to) return res.status(400).json({ message: 'Start date must be on or before the end date' });
  if (daysBetween(from, to) > MAX_CUSTOM_DAYS) return res.status(400).json({ message: 'Choose a range of at most 3 years' });
  const data = await computeRange({ from: new Date(`${from}T00:00:00Z`), to: new Date(new Date(`${to}T00:00:00Z`).getTime() + DAY_MS) });
  res.status(200).json({ data, metrics: metricsMeta, from, to });
});

// GET /api/reports/jobs?page=&limit=&status= — the run history, newest first.
export const jobListValidators = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('status').optional({ checkFalsy: true }).isIn(['running', 'success', 'failed']),
];
export const listJobs = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const page = req.query.page || 1;
  const limit = req.query.limit || 20;
  const filter = req.query.status ? { status: req.query.status } : {};
  const [data, total] = await Promise.all([
    ReportJob.find(filter).sort({ startedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ReportJob.countDocuments(filter),
  ]);
  res.status(200).json({
    data,
    maxRetries: MAX_RETRIES,
    pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
  });
});

// POST /api/reports/jobs { from, to? } — runs the engine now for one day, or each day of a range (at
// most 31). Resolves to the runs.
export const runValidators = [dateParam('from', body), dateParam('to', body).optional({ checkFalsy: true })];
export const runNow = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const from = req.body.from;
  const to = req.body.to || from;
  if (from > to) return res.status(400).json({ message: 'Start date must be on or before the end date' });
  if (to > businessDate()) return res.status(400).json({ message: 'Reports can only be run for today or earlier' });
  if (daysBetween(from, to) > MAX_RUN_DAYS) return res.status(400).json({ message: `Run at most ${MAX_RUN_DAYS} days at a time` });

  const jobs = [];
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= new Date(`${to}T00:00:00Z`).getTime(); t += DAY_MS) {
    // eslint-disable-next-line no-await-in-loop
    jobs.push(await runReportJob(new Date(t).toISOString().slice(0, 10), { trigger: 'manual', triggeredBy: req.admin?.username }));
  }
  const failed = jobs.filter((j) => j.status === 'failed').length;
  res.status(200).json({
    data: jobs,
    message: failed ? `${failed} of ${jobs.length} run(s) failed — see Job History` : `Reports updated for ${jobs.length} day(s)`,
  });
});

// POST /api/reports/jobs/:id/retry — runs a failed day again.
export const retryJob = asyncHandler(async (req, res) => {
  const job = await ReportJob.findById(req.params.id);
  if (!job) return res.status(404).json({ message: 'Run not found' });
  if (job.status !== 'failed') return res.status(400).json({ message: 'Only a failed run can be retried' });
  if (job.retriedBy) return res.status(400).json({ message: 'This run has already been retried' });
  const retry = await runReportJob(job.date, { trigger: 'retry', triggeredBy: req.admin?.username, retryOf: job._id });
  res.status(200).json({
    data: retry,
    message: retry.status === 'success' ? `Reports for ${job.date} updated` : `The retry failed too: ${retry.error}`,
  });
});

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// GET /api/reports/cron — called by Vercel Cron every night (vercel.json), which sends
// "Authorization: Bearer <CRON_SECRET>". Not usable without CRON_SECRET set.
export const cron = asyncHandler(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !sameSecret(req.get('authorization') || '', `Bearer ${secret}`)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const jobs = await runNightlyReports();
  res.status(200).json({ data: jobs.map((j) => ({ _id: j._id, date: j.date, status: j.status, error: j.error })) });
});

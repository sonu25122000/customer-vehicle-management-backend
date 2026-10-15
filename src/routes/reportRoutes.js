import { Router } from 'express';
import * as reports from '../controllers/reportController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   - name: Reports
 *     description: >
 *       Daily / monthly / yearly business reports, filled by the nightly report engine one metric at a
 *       time (utils/reportEngine.js), plus live custom-range reports and the engine's run history.
 *       Trips count towards the day they start on. Admin only.
 * /reports/cron:
 *   get:
 *     tags: [Reports]
 *     summary: Nightly run, called by Vercel Cron with "Authorization Bearer CRON_SECRET"
 *     security: []
 *     responses:
 *       200: { description: Runs }
 *       401: { description: Missing / wrong secret }
 * /reports/daily:
 *   get:
 *     tags: [Reports]
 *     summary: Day rows (default the last 30 days)
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Rows }
 * /reports/monthly:
 *   get:
 *     tags: [Reports]
 *     summary: Month rows of a year (default this year)
 *     parameters:
 *       - { in: query, name: year, schema: { type: string, example: '2026' } }
 *     responses:
 *       200: { description: Rows }
 * /reports/yearly:
 *   get:
 *     tags: [Reports]
 *     summary: Year rows
 *     responses:
 *       200: { description: Rows }
 * /reports/custom:
 *   get:
 *     tags: [Reports]
 *     summary: Every metric for a date range, worked out live
 *     parameters:
 *       - { in: query, name: from, required: true, schema: { type: string, format: date } }
 *       - { in: query, name: to, required: true, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Metrics }
 * /reports/jobs:
 *   get:
 *     tags: [Reports]
 *     summary: Report engine run history, newest first
 *     responses:
 *       200: { description: Runs with each metric's status, attempts and error }
 *   post:
 *     tags: [Reports]
 *     summary: Run the engine now for a day or a range of up to 31 days
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [from], properties: { from: { type: string, format: date }, to: { type: string, format: date } } }
 *     responses:
 *       200: { description: Runs }
 * /reports/jobs/{id}/retry:
 *   post:
 *     tags: [Reports]
 *     summary: Retry a failed run
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The new run }
 */
router.get('/cron', reports.cron);

router.use(requireAuth, requireRole('admin'));
router.get('/daily', reports.dailyValidators, reports.listDaily);
router.get('/monthly', reports.monthlyValidators, reports.listMonthly);
router.get('/yearly', reports.listYearly);
router.get('/custom', reports.customValidators, reports.customReport);
router.get('/jobs', reports.jobListValidators, reports.listJobs);
router.post('/jobs', reports.runValidators, reports.runNow);
router.post('/jobs/:id/retry', reports.retryJob);

export default router;

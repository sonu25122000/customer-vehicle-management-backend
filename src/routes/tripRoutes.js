import { Router } from 'express';
import {
  listTrips,
  getTrip,
  createTrip,
  updateTrip,
  deleteTrip,
  getStats,
  rescheduleTrip,
  listValidators,
  tripValidators,
  rescheduleValidators,
} from '../controllers/tripController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);
// Read access (list/detail/stats) is open to every role, including viewer. Every mutating
// action below requires moderator or admin.
const canEdit = requireRole('moderator', 'admin');

/**
 * @swagger
 * tags:
 *   - name: Trips
 *     description: Bookings — each one gets a server-generated, human-readable tripId (e.g. RW0926AXYZ)
 */

/**
 * @swagger
 * /trips/stats:
 *   get:
 *     tags: [Trips]
 *     summary: Trip summary stats (totals, amounts, status counts)
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Stats }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/stats', getStats);

/**
 * @swagger
 * /trips:
 *   get:
 *     tags: [Trips]
 *     summary: List trips (paginated, searchable by tripId, customer name/mobile, or vehicle number)
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [On Trip, Yet to Start, Completed, Cancelled] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Page of trips
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Trip' } }, pagination: { $ref: '#/components/schemas/Pagination' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Trips]
 *     summary: Create a trip/booking (moderator/admin)
 *     description: tripId is always server-generated (never accepted from the request body); new trips always start as "Yet to Start".
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Trip' }
 *     responses:
 *       201: { description: Created, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/Trip' } } } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', listValidators, listTrips);
router.post('/', canEdit, tripValidators, createTrip);

/**
 * @swagger
 * /trips/{id}:
 *   get:
 *     tags: [Trips]
 *     summary: Get a trip by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Trip, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/Trip' } } } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   put:
 *     tags: [Trips]
 *     summary: Update a trip (moderator/admin)
 *     description: Which fields can change depends on the trip's current status — see EDITABLE_FIELDS_BY_STATUS in tripController.js. Cancelled trips can't be edited at all.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Trip' }
 *     responses:
 *       200: { description: Updated }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { description: The vehicle is already on another active trip, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   delete:
 *     tags: [Trips]
 *     summary: Soft-delete a trip (moderator/admin)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Deleted }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', getTrip);
router.put('/:id', canEdit, tripValidators, updateTrip);
router.patch('/:id', canEdit, tripValidators, updateTrip);
router.delete('/:id', canEdit, deleteTrip);

/**
 * @swagger
 * /trips/{id}/reschedule:
 *   post:
 *     tags: [Trips]
 *     summary: Change a trip's start date/time (moderator/admin)
 *     description: The only way to change start date/time once a trip is past "Yet to Start"; the previous value is preserved in rescheduleHistory.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [startDate, startTime]
 *             properties:
 *               startDate: { type: string, format: date }
 *               startTime: { type: string, example: '09:30' }
 *     responses:
 *       200: { description: Rescheduled }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/reschedule', canEdit, rescheduleValidators, rescheduleTrip);

export default router;

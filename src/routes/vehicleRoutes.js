import { Router } from 'express';
import {
  listVehicles,
  listVehicleOptions,
  getVehicle,
  getVehicleStats,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  listValidators,
  vehicleValidators,
} from '../controllers/vehicleController.js';
import { requireAuth, requireRole, canDelete } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);
// Read access (list/detail/options/stats) is open to every role, including viewer. Every
// mutating action below requires moderator or admin.
const canEdit = requireRole('moderator', 'admin');

/**
 * @swagger
 * tags:
 *   - name: Vehicles
 *     description: Fleet records (photos and documents are under Vehicle Photos / Vehicle Documents)
 */

/**
 * @swagger
 * /vehicles/stats:
 *   get:
 *     tags: [Vehicles]
 *     summary: Vehicle summary stats (total/active/on hold/on trip/available)
 *     responses:
 *       200: { description: Stats }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/stats', getVehicleStats);

/**
 * @swagger
 * /vehicles/options:
 *   get:
 *     tags: [Vehicles]
 *     summary: Lightweight vehicle list for pickers (e.g. the Trip form)
 *     parameters:
 *       - in: query
 *         name: activeOnly
 *         schema: { type: boolean }
 *         description: When true, excludes vehicles that aren't Active or are already on another active trip.
 *     responses:
 *       200:
 *         description: List of vehicles
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Vehicle' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/options', listVehicleOptions);

/**
 * @swagger
 * /vehicles:
 *   get:
 *     tags: [Vehicles]
 *     summary: List vehicles (paginated, searchable)
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Page of vehicles
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Vehicle' } }, pagination: { $ref: '#/components/schemas/Pagination' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Vehicles]
 *     summary: Create a vehicle (moderator/admin)
 *     description: Always created with status "On Hold" — Active requires all 4 photo sides, uploaded afterwards via POST /vehicle-photos.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Vehicle' }
 *     responses:
 *       201: { description: Created, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/Vehicle' } } } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.get('/', listValidators, listVehicles);
router.post('/', canEdit, vehicleValidators, createVehicle);

/**
 * @swagger
 * /vehicles/{id}:
 *   get:
 *     tags: [Vehicles]
 *     summary: Get a vehicle by id (includes trip-derived stats)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Vehicle, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/Vehicle' } } } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   put:
 *     tags: [Vehicles]
 *     summary: Update a vehicle (moderator/admin)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Vehicle' }
 *     responses:
 *       200: { description: Updated }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *   delete:
 *     tags: [Vehicles]
 *     summary: Soft-delete a vehicle (admin only)
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
router.get('/:id', getVehicle);
router.put('/:id', canEdit, vehicleValidators, updateVehicle);
router.patch('/:id', canEdit, vehicleValidators, updateVehicle);
router.delete('/:id', canDelete, deleteVehicle);

export default router;

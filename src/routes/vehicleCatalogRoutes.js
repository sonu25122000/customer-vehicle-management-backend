import { Router } from 'express';
import {
  listCatalog,
  addCatalogItem,
  removeCatalogItem,
  catalogItemValidators,
} from '../controllers/vehicleCatalogController.js';
import { requireAuth, requireRole, canDelete } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);
// Read access (list) is open to every role, including viewer. Every mutating action below
// requires moderator or admin.
const canEdit = requireRole('moderator', 'admin');

/**
 * @swagger
 * tags:
 *   - name: Vehicle Catalog
 *     description: Admin-managed vehicle type/category/make/model tree used by the Vehicle form
 */

/**
 * @swagger
 * /vehicle-catalog:
 *   get:
 *     tags: [Vehicle Catalog]
 *     summary: Get the vehicle type/category/make/model tree
 *     responses:
 *       200:
 *         description: Catalog tree
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     vehicleTypes:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name: { type: string }
 *                           categories: { type: array, items: { type: string } }
 *                           makes:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 name: { type: string }
 *                                 models: { type: array, items: { type: string } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Vehicle Catalog]
 *     summary: Add a vehicle type, category, make or model (moderator/admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [kind, name]
 *             properties:
 *               kind: { type: string, enum: [vehicleType, category, make, model] }
 *               name: { type: string, maxLength: 60 }
 *               vehicleType: { type: string, description: 'Required when kind is category, make or model' }
 *               make: { type: string, description: 'Required when kind is model' }
 *     responses:
 *       200: { description: Updated catalog }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', listCatalog);
router.post('/', canEdit, catalogItemValidators, addCatalogItem);

/**
 * @swagger
 * /vehicle-catalog/remove:
 *   post:
 *     tags: [Vehicle Catalog]
 *     summary: Soft-delete a vehicle type, category, make or model (admin only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [kind, name]
 *             properties:
 *               kind: { type: string, enum: [vehicleType, category, make, model] }
 *               name: { type: string }
 *               vehicleType: { type: string, description: 'Required when kind is category, make or model' }
 *               make: { type: string, description: 'Required when kind is model' }
 *     responses:
 *       200: { description: Updated catalog }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/remove', canDelete, catalogItemValidators, removeCatalogItem);

export default router;

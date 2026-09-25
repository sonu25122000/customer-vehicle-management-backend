import { Router } from 'express';
import {
  listVehiclePhotos,
  getVehiclePhoto,
  uploadVehiclePhotos,
  deleteVehiclePhoto,
  listValidators,
  uploadValidators,
} from '../controllers/vehiclePhotoController.js';
import { requireAuth, requireRole, canDelete } from '../middleware/auth.js';
import { uploadVehiclePhotos as uploadVehiclePhotosMiddleware, handleUploadErrors } from '../middleware/upload.js';

const router = Router();

router.use(requireAuth);
// Viewing is open to every role; uploading needs moderator/admin, deleting is admin-only — same as
// the rest of the vehicle module.
const canEdit = requireRole('moderator', 'admin');

/**
 * @swagger
 * tags:
 *   - name: Vehicle Photos
 *     description: >
 *       Vehicle photos, stored in their own collection and linked to the vehicle by id. One active
 *       photo per side (front/back/passengerSide/driverSide), plus up to 10 additional photos. A
 *       vehicle can only be set Active once all four sides are on file.
 */

/**
 * @swagger
 * /vehicle-photos:
 *   get:
 *     tags: [Vehicle Photos]
 *     summary: List a vehicle's photos (with image data)
 *     parameters:
 *       - in: query
 *         name: vehicle
 *         required: true
 *         schema: { type: string }
 *         description: Vehicle ObjectId
 *     responses:
 *       200:
 *         description: The vehicle's active photos
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/VehiclePhoto' } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Vehicle Photos]
 *     summary: Upload vehicle photos (moderator/admin)
 *     description: >
 *       JPEG/PNG/WebP, max 1.5MB each. A side photo replaces that side's previous photo; additional
 *       photos (up to 5 per request) are appended, up to 10 per vehicle.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [vehicle]
 *             properties:
 *               vehicle: { type: string, description: Vehicle ObjectId }
 *               front: { type: string, format: binary }
 *               back: { type: string, format: binary }
 *               passengerSide: { type: string, format: binary }
 *               driverSide: { type: string, format: binary }
 *               additional: { type: array, items: { type: string, format: binary } }
 *     responses:
 *       200:
 *         description: Uploaded; returns the vehicle's active photos
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/VehiclePhoto' } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/', listValidators, listVehiclePhotos);
router.post('/', canEdit, uploadVehiclePhotosMiddleware, handleUploadErrors, uploadValidators, uploadVehiclePhotos);

/**
 * @swagger
 * /vehicle-photos/{id}:
 *   get:
 *     tags: [Vehicle Photos]
 *     summary: Get one vehicle photo
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Photo, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/VehiclePhoto' } } } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Vehicle Photos]
 *     summary: Remove a vehicle photo (admin only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Removed; returns the vehicle's remaining photos }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', getVehiclePhoto);
router.delete('/:id', canDelete, deleteVehiclePhoto);

export default router;

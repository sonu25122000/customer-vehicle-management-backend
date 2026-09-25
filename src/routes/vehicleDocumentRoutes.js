import { Router } from 'express';
import {
  listVehicleDocuments,
  getVehicleDocument,
  uploadVehicleDocuments,
  deleteVehicleDocument,
  listValidators,
  uploadValidators,
} from '../controllers/vehicleDocumentController.js';
import { requireAuth, requireRole, canDelete } from '../middleware/auth.js';
import { uploadVehicleDocuments as uploadVehicleDocumentsMiddleware, handleUploadErrors } from '../middleware/upload.js';

const router = Router();

router.use(requireAuth);
// Viewing is open to every role; uploading needs moderator/admin, deleting is admin-only — same as
// the rest of the vehicle module.
const canEdit = requireRole('moderator', 'admin');

/**
 * @swagger
 * tags:
 *   - name: Vehicle Documents
 *     description: >
 *       Vehicle RC and insurance documents, stored in their own collection and linked to the vehicle
 *       by id. At most one active document per vehicle per type; uploading a type again replaces it.
 */

/**
 * @swagger
 * /vehicle-documents:
 *   get:
 *     tags: [Vehicle Documents]
 *     summary: List a vehicle's documents (with file data)
 *     parameters:
 *       - in: query
 *         name: vehicle
 *         required: true
 *         schema: { type: string }
 *         description: Vehicle ObjectId
 *     responses:
 *       200:
 *         description: The vehicle's active documents
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/VehicleDocument' } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Vehicle Documents]
 *     summary: Upload RC/insurance documents (moderator/admin)
 *     description: Images (JPEG/PNG/WebP) or PDF, max 1.5MB each.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [vehicle]
 *             properties:
 *               vehicle: { type: string, description: Vehicle ObjectId }
 *               rc: { type: string, format: binary }
 *               insurance: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Uploaded; returns the vehicle's active documents
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/VehicleDocument' } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/', listValidators, listVehicleDocuments);
router.post('/', canEdit, uploadVehicleDocumentsMiddleware, handleUploadErrors, uploadValidators, uploadVehicleDocuments);

/**
 * @swagger
 * /vehicle-documents/{id}:
 *   get:
 *     tags: [Vehicle Documents]
 *     summary: Get one vehicle document
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Document, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/VehicleDocument' } } } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Vehicle Documents]
 *     summary: Soft-delete a vehicle document (admin only)
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
router.get('/:id', getVehicleDocument);
router.delete('/:id', canDelete, deleteVehicleDocument);

export default router;

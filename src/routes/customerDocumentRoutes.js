import { Router } from 'express';
import {
  listCustomerDocuments,
  getCustomerDocument,
  uploadCustomerDocuments,
  deleteCustomerDocument,
  listValidators,
  uploadValidators,
} from '../controllers/customerDocumentController.js';
import { requireAuth, requireRole, canDelete } from '../middleware/auth.js';
import { uploadCustomerDocuments as uploadCustomerDocumentsMiddleware, handleUploadErrors } from '../middleware/upload.js';

const router = Router();

router.use(requireAuth);
// Viewing is open to every role; uploading needs moderator/admin, deleting is admin-only — same as
// the rest of the customer module.
const canEdit = requireRole('moderator', 'admin');

/**
 * @swagger
 * tags:
 *   - name: Customer Documents
 *     description: >
 *       Customer verification documents (selfie, driving licence, Aadhaar, other), stored in their own
 *       collection and linked to the customer by id. At most one active document per customer per type;
 *       uploading a type again replaces the previous one.
 */

/**
 * @swagger
 * /customer-documents:
 *   get:
 *     tags: [Customer Documents]
 *     summary: List a customer's documents (with file data)
 *     parameters:
 *       - in: query
 *         name: customer
 *         required: true
 *         schema: { type: string }
 *         description: Customer ObjectId
 *     responses:
 *       200:
 *         description: The customer's active documents
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/CustomerDocument' } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Customer Documents]
 *     summary: Upload customer documents (moderator/admin)
 *     description: Images (JPEG/PNG/WebP) or PDF, max 1.5MB each. Selfie is image-only on the frontend.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [customer]
 *             properties:
 *               customer: { type: string, description: Customer ObjectId }
 *               selfie: { type: string, format: binary }
 *               drivingLicence: { type: string, format: binary }
 *               aadhaar: { type: string, format: binary }
 *               other: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Uploaded; returns the customer's active documents
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/CustomerDocument' } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/', listValidators, listCustomerDocuments);
router.post('/', canEdit, uploadCustomerDocumentsMiddleware, handleUploadErrors, uploadValidators, uploadCustomerDocuments);

/**
 * @swagger
 * /customer-documents/{id}:
 *   get:
 *     tags: [Customer Documents]
 *     summary: Get one customer document
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Document, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/CustomerDocument' } } } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Customer Documents]
 *     summary: Soft-delete a customer document (admin only)
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
router.get('/:id', getCustomerDocument);
router.delete('/:id', canDelete, deleteCustomerDocument);

export default router;

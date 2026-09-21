import { Router } from 'express';
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getStats,
  listCustomerOptions,
  uploadCustomerDocuments,
  listValidators,
  statsValidators,
  customerValidators,
} from '../controllers/customerController.js';
import { requireAuth, requireRole, canDelete } from '../middleware/auth.js';
import { uploadCustomerDocuments as uploadCustomerDocumentsMiddleware, handleUploadErrors } from '../middleware/upload.js';

const router = Router();

router.use(requireAuth);
// Read access (list/detail/options/stats) is open to every role, including viewer. Every
// mutating action below requires moderator or admin.
const canEdit = requireRole('moderator', 'admin');

/**
 * @swagger
 * tags:
 *   - name: Customers
 *     description: Renter records, verification and documents
 */

/**
 * @swagger
 * /customers/stats:
 *   get:
 *     tags: [Customers]
 *     summary: Customer summary stats
 *     responses:
 *       200: { description: Stats }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/stats', statsValidators, getStats);

/**
 * @swagger
 * /customers/options:
 *   get:
 *     tags: [Customers]
 *     summary: Lightweight customer list for pickers (e.g. the Trip form, coupon audience picker)
 *     responses:
 *       200:
 *         description: List of customers
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Customer' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/options', listCustomerOptions);

/**
 * @swagger
 * /customers:
 *   get:
 *     tags: [Customers]
 *     summary: List customers (paginated, searchable)
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
 *         description: Page of customers
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Customer' } }, pagination: { $ref: '#/components/schemas/Pagination' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Customers]
 *     summary: Create a customer (moderator/admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Customer' }
 *     responses:
 *       201: { description: Created, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/Customer' } } } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', listValidators, listCustomers);
router.post('/', canEdit, customerValidators, createCustomer);

/**
 * @swagger
 * /customers/{id}:
 *   get:
 *     tags: [Customers]
 *     summary: Get a customer by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Customer, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/Customer' } } } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   put:
 *     tags: [Customers]
 *     summary: Update a customer (moderator/admin)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Customer' }
 *     responses:
 *       200: { description: Updated }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Customers]
 *     summary: Soft-delete a customer (admin only)
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
router.get('/:id', getCustomer);
router.put('/:id', canEdit, customerValidators, updateCustomer);
router.patch('/:id', canEdit, customerValidators, updateCustomer);
router.delete('/:id', canDelete, deleteCustomer);

/**
 * @swagger
 * /customers/{id}/documents:
 *   post:
 *     tags: [Customers]
 *     summary: Upload verification documents (selfie, driving licence, Aadhaar) (moderator/admin)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               selfie: { type: string, format: binary }
 *               drivingLicence: { type: string, format: binary }
 *               aadhaar: { type: string, format: binary }
 *               other: { type: string, format: binary }
 *     responses:
 *       200: { description: Uploaded }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/documents', canEdit, uploadCustomerDocumentsMiddleware, handleUploadErrors, uploadCustomerDocuments);

export default router;

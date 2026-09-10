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
import { requireAuth } from '../middleware/auth.js';
import { uploadCustomerDocuments as uploadCustomerDocumentsMiddleware, handleUploadErrors } from '../middleware/upload.js';

const router = Router();

router.use(requireAuth);

router.get('/stats', statsValidators, getStats);
router.get('/options', listCustomerOptions);
router.get('/', listValidators, listCustomers);
router.get('/:id', getCustomer);
router.post('/', customerValidators, createCustomer);
router.put('/:id', customerValidators, updateCustomer);
router.patch('/:id', customerValidators, updateCustomer);
router.delete('/:id', deleteCustomer);
router.post('/:id/documents', uploadCustomerDocumentsMiddleware, handleUploadErrors, uploadCustomerDocuments);

export default router;

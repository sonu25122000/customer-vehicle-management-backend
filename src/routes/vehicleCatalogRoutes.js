import { Router } from 'express';
import {
  listCatalog,
  addCatalogItem,
  removeCatalogItem,
  catalogItemValidators,
} from '../controllers/vehicleCatalogController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

router.get('/', listCatalog);
router.post('/', catalogItemValidators, addCatalogItem);
router.post('/remove', catalogItemValidators, removeCatalogItem);

export default router;

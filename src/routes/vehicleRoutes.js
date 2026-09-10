import { Router } from 'express';
import {
  listVehicles,
  listVehicleOptions,
  getVehicle,
  getVehicleStats,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  uploadVehiclePhotos as uploadVehiclePhotosController,
  deleteVehiclePhoto,
  uploadVehicleDocuments as uploadVehicleDocumentsController,
  listValidators,
  vehicleValidators,
} from '../controllers/vehicleController.js';
import { requireAuth } from '../middleware/auth.js';
import { uploadVehiclePhotos, uploadVehicleDocuments, handleUploadErrors } from '../middleware/upload.js';

const router = Router();

router.use(requireAuth);

router.get('/stats', getVehicleStats);
router.get('/options', listVehicleOptions);
router.get('/', listValidators, listVehicles);
router.get('/:id', getVehicle);
router.post('/', vehicleValidators, createVehicle);
router.put('/:id', vehicleValidators, updateVehicle);
router.patch('/:id', vehicleValidators, updateVehicle);
router.delete('/:id', deleteVehicle);
router.post('/:id/photos', uploadVehiclePhotos, handleUploadErrors, uploadVehiclePhotosController);
router.delete('/:id/photos/:slot', deleteVehiclePhoto);
router.post('/:id/documents', uploadVehicleDocuments, handleUploadErrors, uploadVehicleDocumentsController);

export default router;

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
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

router.get('/stats', getStats);
router.get('/', listValidators, listTrips);
router.get('/:id', getTrip);
router.post('/', tripValidators, createTrip);
router.put('/:id', tripValidators, updateTrip);
router.patch('/:id', tripValidators, updateTrip);
router.post('/:id/reschedule', rescheduleValidators, rescheduleTrip);
router.delete('/:id', deleteTrip);

export default router;

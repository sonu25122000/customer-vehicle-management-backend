import { Router } from 'express';
import {
  listTestimonials,
  listReviewCandidates,
  createTestimonial,
  updateTestimonial,
  reorderTestimonials,
  deleteTestimonial,
  testimonialValidators,
  reorderValidators,
} from '../controllers/testimonialController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// The customer site home page's reviews carousel — managed by moderators and admins.
const router = Router();
router.use(requireAuth, requireRole('moderator', 'admin'));

/**
 * @swagger
 * tags:
 *   - name: Home Carousel
 *     description: >
 *       Reviews shown in the carousel on the customer site's home page (up to 7 active slides, in
 *       order). Slides are written by an admin or picked from customers' trip reviews.
 * /testimonials:
 *   get:
 *     tags: [Home Carousel]
 *     summary: All slides, in carousel order (moderator/admin)
 *     responses:
 *       200: { description: 'Slides, plus maxActive' }
 *   post:
 *     tags: [Home Carousel]
 *     summary: Add a slide at the end (moderator/admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, text, rating]
 *             properties:
 *               name: { type: string }
 *               subtitle: { type: string }
 *               text: { type: string }
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *               carName: { type: string }
 *               trip: { type: string, description: 'Trip the review came from, if picked from customer reviews' }
 *               isActive: { type: boolean }
 *     responses:
 *       201: { description: Added }
 *       400: { $ref: '#/components/responses/ValidationError' }
 * /testimonials/reviews:
 *   get:
 *     tags: [Home Carousel]
 *     summary: Customers' trip reviews that can be added to the carousel (moderator/admin)
 *     responses:
 *       200: { description: Reviews }
 * /testimonials/order:
 *   put:
 *     tags: [Home Carousel]
 *     summary: Save the slide order (moderator/admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [ids], properties: { ids: { type: array, items: { type: string } } } }
 *     responses:
 *       200: { description: Saved }
 * /testimonials/{id}:
 *   put:
 *     tags: [Home Carousel]
 *     summary: Edit a slide or show/hide it (moderator/admin)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Updated }
 *   delete:
 *     tags: [Home Carousel]
 *     summary: Remove a slide (moderator/admin)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Removed }
 */
router.get('/', listTestimonials);
router.get('/reviews', listReviewCandidates);
router.post('/', testimonialValidators, createTestimonial);
router.put('/order', reorderValidators, reorderTestimonials);
router.put('/:id', testimonialValidators, updateTestimonial);
router.delete('/:id', deleteTestimonial);

export default router;

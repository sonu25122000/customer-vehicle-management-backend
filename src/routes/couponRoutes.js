import { Router } from 'express';
import {
  listCoupons,
  getCoupon,
  getCouponStats,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  listValidators,
  couponValidators,
} from '../controllers/couponController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// Coupons & Offers is an admin-only module end to end — not just create/edit/delete, but
// viewing too (the tab is hidden entirely for viewer/moderator on the frontend; this is the
// backend enforcement of the same rule).
router.use(requireAuth, requireRole('admin'));

/**
 * @swagger
 * tags:
 *   - name: Coupons
 *     description: Customer discount codes — admin only, end to end
 */

/**
 * @swagger
 * /coupons/stats:
 *   get:
 *     tags: [Coupons]
 *     summary: Coupon summary stats (total/active/expired) (admin only)
 *     responses:
 *       200: { description: Stats }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/stats', getCouponStats);

/**
 * @swagger
 * /coupons:
 *   get:
 *     tags: [Coupons]
 *     summary: List coupons (paginated, searchable by code) (admin only)
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
 *         description: Page of coupons
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Coupon' } }, pagination: { $ref: '#/components/schemas/Pagination' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Coupons]
 *     summary: Create a coupon (admin only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Coupon' }
 *     responses:
 *       201: { description: Created, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/Coupon' } } } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.get('/', listValidators, listCoupons);
router.post('/', couponValidators, createCoupon);

/**
 * @swagger
 * /coupons/{id}:
 *   get:
 *     tags: [Coupons]
 *     summary: Get a coupon by id (admin only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Coupon, content: { application/json: { schema: { type: object, properties: { data: { $ref: '#/components/schemas/Coupon' } } } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   put:
 *     tags: [Coupons]
 *     summary: Update a coupon (admin only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Coupon' }
 *     responses:
 *       200: { description: Updated }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *   delete:
 *     tags: [Coupons]
 *     summary: Soft-delete a coupon (admin only)
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
router.get('/:id', getCoupon);
router.put('/:id', couponValidators, updateCoupon);
router.patch('/:id', couponValidators, updateCoupon);
router.delete('/:id', deleteCoupon);

export default router;

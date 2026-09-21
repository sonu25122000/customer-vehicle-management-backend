import { Router } from 'express';
import {
  listCoupons,
  getCoupon,
  getCouponStats,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  listApplicableCoupons,
  listValidators,
  applicableValidators,
  couponValidators,
} from '../controllers/couponController.js';
import { requireAuth, requireRole, canDelete } from '../middleware/auth.js';

const router = Router();

// Coupons & Offers is open to moderators and admins — viewing, creating and editing. Viewers get
// no access at all (the tab is hidden for them on the frontend; this is the backend enforcement of
// the same rule). Deleting a coupon is admin-only (canDelete on the DELETE route below).
router.use(requireAuth, requireRole('moderator', 'admin'));

/**
 * @swagger
 * tags:
 *   - name: Coupons
 *     description: >
 *       Customer discount codes. Moderators and admins can view, create and edit them; deleting is
 *       admin-only. Start/expiry must be on a 30-minute interval, expiry must be after start, and
 *       every coupon has a maximum usage count that is enforced when it is applied to a trip.
 */

/**
 * @swagger
 * /coupons/applicable:
 *   get:
 *     tags: [Coupons]
 *     summary: Coupons the trip form can offer for a customer (moderator/admin)
 *     description: >
 *       Returns only coupons that are usable right now for this customer — active, inside their
 *       start/expiry window, not used up (usageCount < maxUsage), and either applicable to all
 *       customers or listing this customer. Used by the Create Trip form's Coupon dropdown.
 *     parameters:
 *       - in: query
 *         name: customer
 *         required: true
 *         schema: { type: string }
 *         description: Customer ObjectId
 *     responses:
 *       200:
 *         description: Applicable coupons
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Coupon' } } } }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/applicable', applicableValidators, listApplicableCoupons);

/**
 * @swagger
 * /coupons/stats:
 *   get:
 *     tags: [Coupons]
 *     summary: Coupon summary stats (total/active/expired) (moderator/admin)
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
 *     summary: List coupons (paginated, searchable by code) (moderator/admin)
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
 *     summary: Create a coupon (moderator/admin)
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
 *     summary: Get a coupon by id (moderator/admin)
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
 *     summary: Update a coupon (moderator/admin)
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
 *     summary: Soft-delete a coupon (admin only — moderators get 403)
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
router.delete('/:id', canDelete, deleteCoupon);

export default router;

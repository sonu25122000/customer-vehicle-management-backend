import { Router } from 'express';
import * as expenses from '../controllers/expenseController.js';
import { requireAuth, requireRole, canDelete } from '../middleware/auth.js';

// Vehicle expenses (feed the reports' "Vehicle Expense"). Moderators and admins add and edit them;
// deleting is admin-only, like everywhere else.
const router = Router();
router.use(requireAuth, requireRole('moderator', 'admin'));

/**
 * @swagger
 * tags:
 *   - name: Expenses
 *     description: Money spent on vehicles (fuel, service, repairs...), counted in the reports by date
 * /expenses:
 *   get:
 *     tags: [Expenses]
 *     summary: List expenses (moderator/admin)
 *     parameters:
 *       - { in: query, name: vehicle, schema: { type: string } }
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: 'Expenses, totalAmount, categories' }
 *   post:
 *     tags: [Expenses]
 *     summary: Add an expense (moderator/admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vehicle, date, amount, category]
 *             properties:
 *               vehicle: { type: string }
 *               date: { type: string, format: date }
 *               amount: { type: number }
 *               category: { type: string, enum: [Fuel, Service, Repair, Cleaning, Insurance, Parking, Other] }
 *               note: { type: string }
 *     responses:
 *       201: { description: Added }
 * /expenses/{id}:
 *   put:
 *     tags: [Expenses]
 *     summary: Edit an expense (moderator/admin)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Updated }
 *   delete:
 *     tags: [Expenses]
 *     summary: Delete an expense (admin)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted }
 */
router.get('/', expenses.listValidators, expenses.listExpenses);
router.post('/', expenses.expenseValidators, expenses.createExpense);
router.put('/:id', expenses.expenseValidators, expenses.updateExpense);
router.delete('/:id', canDelete, expenses.deleteExpense);

export default router;

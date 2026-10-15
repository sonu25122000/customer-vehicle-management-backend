import { body, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import VehicleExpense, { EXPENSE_CATEGORIES } from '../models/VehicleExpense.js';
import Vehicle from '../models/Vehicle.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VEHICLE_POPULATE = 'vehicleNo make model';

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

export const listValidators = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('vehicle').optional({ checkFalsy: true }).isMongoId(),
  query('from').optional({ checkFalsy: true }).matches(DATE_RE),
  query('to').optional({ checkFalsy: true }).matches(DATE_RE),
];

// GET /api/expenses?vehicle=&from=&to=&page=&limit= — newest first, with the total of the filter.
export const listExpenses = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const page = req.query.page || 1;
  const limit = req.query.limit || 20;
  const filter = { isDeleted: false };
  if (req.query.vehicle) filter.vehicle = new mongoose.Types.ObjectId(req.query.vehicle);
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = new Date(`${req.query.from}T00:00:00Z`);
    if (req.query.to) filter.date.$lte = new Date(`${req.query.to}T00:00:00Z`);
  }
  const [data, total, [sum]] = await Promise.all([
    VehicleExpense.find(filter).populate('vehicle', VEHICLE_POPULATE).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    VehicleExpense.countDocuments(filter),
    VehicleExpense.aggregate([{ $match: filter }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
  ]);
  res.status(200).json({
    data,
    totalAmount: sum?.amount || 0,
    categories: EXPENSE_CATEGORIES,
    pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
  });
});

export const expenseValidators = [
  body('vehicle').isMongoId().withMessage('Select a vehicle'),
  body('date').matches(DATE_RE).withMessage('Select a date'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0').toFloat(),
  body('category').isIn(EXPENSE_CATEGORIES).withMessage('Select a category'),
  body('note').optional({ checkFalsy: true }).trim().isLength({ max: 200 }).withMessage('Note cannot exceed 200 characters'),
];

async function vehicleExists(id) {
  return Vehicle.exists({ _id: id, isDeleted: false });
}

// POST /api/expenses
export const createExpense = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  if (!(await vehicleExists(req.body.vehicle))) return res.status(400).json({ message: 'Selected vehicle does not exist' });
  const { vehicle, date, amount, category, note } = req.body;
  const expense = await VehicleExpense.create({
    vehicle,
    date: new Date(`${date}T00:00:00Z`),
    amount,
    category,
    note: note || '',
    createdBy: req.admin?.username || '',
  });
  await expense.populate('vehicle', VEHICLE_POPULATE);
  res.status(201).json({ data: expense, message: 'Expense added' });
});

// PUT /api/expenses/:id
export const updateExpense = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  const expense = await VehicleExpense.findOne({ _id: req.params.id, isDeleted: false });
  if (!expense) return res.status(404).json({ message: 'Expense not found' });
  if (!(await vehicleExists(req.body.vehicle))) return res.status(400).json({ message: 'Selected vehicle does not exist' });
  const { vehicle, date, amount, category, note } = req.body;
  expense.set({ vehicle, date: new Date(`${date}T00:00:00Z`), amount, category, note: note || '' });
  await expense.save();
  await expense.populate('vehicle', VEHICLE_POPULATE);
  res.status(200).json({ data: expense, message: 'Expense updated' });
});

// DELETE /api/expenses/:id — soft delete
export const deleteExpense = asyncHandler(async (req, res) => {
  const expense = await VehicleExpense.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, { isDeleted: true });
  if (!expense) return res.status(404).json({ message: 'Expense not found' });
  res.status(200).json({ message: 'Expense deleted' });
});

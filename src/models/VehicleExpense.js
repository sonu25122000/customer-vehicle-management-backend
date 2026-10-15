import mongoose from 'mongoose';

export const EXPENSE_CATEGORIES = ['Fuel', 'Service', 'Repair', 'Cleaning', 'Insurance', 'Parking', 'Other'];

// Money spent on a vehicle on a given day (fuel, servicing, repairs...). Entered from the admin portal's
// Expenses page; feeds the "Vehicle Expense" metric of the reports (utils/reportEngine.js).
const vehicleExpenseSchema = new mongoose.Schema(
  {
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: [true, 'Vehicle is required'] },
    // The business day the money was spent, stored as that date at 00:00 UTC (same as Trip.startDate).
    date: { type: Date, required: [true, 'Date is required'] },
    amount: { type: Number, required: [true, 'Amount is required'], min: [0, 'Amount cannot be negative'] },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: 'Other' },
    note: { type: String, trim: true, maxlength: 200, default: '' },
    createdBy: { type: String, default: '' },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

vehicleExpenseSchema.index({ isDeleted: 1, date: -1 });
vehicleExpenseSchema.index({ vehicle: 1, isDeleted: 1, date: -1 });

export default mongoose.model('VehicleExpense', vehicleExpenseSchema);

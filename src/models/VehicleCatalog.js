import mongoose from 'mongoose';

const modelItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    isDeleted: { type: Boolean, default: false },
  },
  { _id: false }
);

const categoryItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    isDeleted: { type: Boolean, default: false },
  },
  { _id: false }
);

const makeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    isDeleted: { type: Boolean, default: false },
    models: { type: [modelItemSchema], default: [] },
  },
  { _id: false }
);

const vehicleTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    isDeleted: { type: Boolean, default: false },
    categories: { type: [categoryItemSchema], default: [] },
    makes: { type: [makeSchema], default: [] },
  },
  { _id: false }
);

// The entire vehicle type / category / make / model catalog lives in a single document —
// one JSON tree (vehicleTypes -> categories + makes -> models) instead of a flat table of
// individually-typed rows. There is exactly one document in this collection (a singleton,
// same idea as a one-row config table); see vehicleCatalogController.js for how it's read and
// mutated. Fully admin-managed from the "Vehicle Catalog" tab — no hardcoded data anywhere.
//
// Deletes are soft (isDeleted, same convention as Customer/Vehicle/Trip) at every level —
// removing a vehicle type or make also soft-deletes everything nested under it. The public API
// (vehicleCatalogController's serializeCatalog) strips isDeleted entries out entirely before
// they ever reach a response, so nothing deleted is visible anywhere in the UI.
const vehicleCatalogSchema = new mongoose.Schema(
  {
    vehicleTypes: { type: [vehicleTypeSchema], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model('VehicleCatalog', vehicleCatalogSchema);

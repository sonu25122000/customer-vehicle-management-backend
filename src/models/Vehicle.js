import mongoose from 'mongoose';

const vehicleSchema = new mongoose.Schema(
  {
    vehicleNo: {
      type: String,
      required: [true, 'Vehicle number is required'],
      trim: true,
      uppercase: true,
      match: [/^[A-Z]{2}[0-9]{1,2}[A-Z]{1,2}[0-9]{4}$/, 'Enter a valid vehicle number (e.g. KA01AB1234)'],
    },
    // vehicleType and vehicleCategory's valid options live in the single VehicleCatalog document
    // and are enforced by vehicleController's async validators — not schema enums here, since
    // the admin-managed catalog can grow over time (see vehicleCatalogController.js).
    vehicleType: {
      type: String,
      required: [true, 'Vehicle type is required'],
      trim: true,
    },
    vehicleCategory: {
      type: String,
      required: [true, 'Vehicle category is required'],
      trim: true,
    },
    transmission: {
      type: String,
      required: [true, 'Transmission is required'],
      enum: ['Manual', 'Automatic'],
    },
    fuel: {
      type: String,
      required: [true, 'Fuel type is required'],
      enum: ['Petrol', 'Diesel', 'CNG', 'Electric'],
    },
    status: {
      type: String,
      enum: ['Active', 'On Hold', 'Inactive'],
      default: 'On Hold',
    },
    make: {
      type: String,
      required: [true, 'Make is required'],
      trim: true,
      default: '',
    },
    model: {
      type: String,
      required: [true, 'Model is required'],
      trim: true,
      default: '',
    },
    ownerName: {
      type: String,
      required: [true, 'Owner/Host name is required'],
      trim: true,
    },
    ownerMobile: {
      type: String,
      required: [true, 'Owner mobile is required'],
      trim: true,
    },
    // Stored as base64 data URIs directly in the document (no filesystem/object storage
    // configured for this project) — kept small via upload-time size limits so a vehicle
    // document stays well under MongoDB's 16MB document cap.
    photos: {
      front: { type: String, default: '' },
      back: { type: String, default: '' },
      passengerSide: { type: String, default: '' },
      driverSide: { type: String, default: '' },
      additional: { type: [String], default: [] },
    },
    // Same storage approach as photos — base64 data URIs, image or PDF.
    documents: {
      rc: { type: String, default: '' },
      insurance: { type: String, default: '' },
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Uniqueness only enforced among active (non-deleted) vehicles, so a soft-deleted
// vehicle's number can be reused by a new active vehicle.
vehicleSchema.index({ vehicleNo: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
vehicleSchema.index({ ownerName: 1 });
vehicleSchema.index({ ownerMobile: 1 });
vehicleSchema.index({ isDeleted: 1 });

export default mongoose.model('Vehicle', vehicleSchema);

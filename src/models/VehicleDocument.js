import mongoose from 'mongoose';

export const VEHICLE_DOCUMENT_TYPES = ['rc', 'insurance'];

// One row per vehicle document (RC / insurance, image or PDF), linked to its vehicle by id. These
// used to be embedded on the Vehicle record (vehicle.documents.*). Re-uploading a type soft-deletes
// the previous row, so there's at most one active row per vehicle per type.
const vehicleDocumentSchema = new mongoose.Schema(
  {
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle',
      required: [true, 'Vehicle is required'],
    },
    type: {
      type: String,
      enum: VEHICLE_DOCUMENT_TYPES,
      required: [true, 'Document type is required'],
    },
    // base64 data URI.
    file: {
      type: String,
      required: true,
    },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

vehicleDocumentSchema.index({ vehicle: 1, isDeleted: 1, type: 1 });

export default mongoose.model('VehicleDocument', vehicleDocumentSchema);

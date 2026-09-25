import mongoose from 'mongoose';

// The four required sides (one active photo each) plus any number of 'additional' photos (capped at
// MAX_ADDITIONAL_PHOTOS by the upload endpoint).
export const MAIN_PHOTO_SLOTS = ['front', 'back', 'passengerSide', 'driverSide'];
export const PHOTO_SLOTS = [...MAIN_PHOTO_SLOTS, 'additional'];
export const MAX_ADDITIONAL_PHOTOS = 10;

// One row per vehicle photo, linked to its vehicle by id. Photos used to be embedded on the Vehicle
// record (vehicle.photos.*). Vehicle documents (RC/insurance) live in their own VehicleDocument collection.
const vehiclePhotoSchema = new mongoose.Schema(
  {
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle',
      required: [true, 'Vehicle is required'],
    },
    slot: {
      type: String,
      enum: PHOTO_SLOTS,
      required: [true, 'Photo slot is required'],
    },
    // base64 data URI.
    image: {
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

vehiclePhotoSchema.index({ vehicle: 1, isDeleted: 1, slot: 1 });

export default mongoose.model('VehiclePhoto', vehiclePhotoSchema);

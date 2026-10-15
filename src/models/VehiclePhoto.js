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
    // The file's object key in the S3 bucket (utils/storage.js). `image` is legacy: files uploaded before
    // S3 was introduced were stored here as a base64 data URI. It's never written any more, and
    // `npm run migrate:s3` moves those files into S3 and clears it.
    s3Key: { type: String },
    image: { type: String },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

vehiclePhotoSchema.pre('validate', function requireFile(next) {
  if (!this.s3Key && !this.image) this.invalidate('image', 'File is required');
  next();
});

vehiclePhotoSchema.index({ vehicle: 1, isDeleted: 1, slot: 1 });

export default mongoose.model('VehiclePhoto', vehiclePhotoSchema);

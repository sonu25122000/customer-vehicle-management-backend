import { body, query, validationResult } from 'express-validator';
import Vehicle from '../models/Vehicle.js';
import VehiclePhoto, { MAIN_PHOTO_SLOTS, MAX_ADDITIONAL_PHOTOS } from '../models/VehiclePhoto.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { objectKey, storeFile, withFileUrls } from '../utils/storage.js';
import { vehiclePhotoKeyParts } from '../utils/fileNames.js';
import { holdIfIncomplete } from '../utils/media.js';

const VEHICLE_POPULATE = 'vehicleNo make model';

export const listValidators = [query('vehicle').isMongoId().withMessage('A valid vehicle is required')];
export const uploadValidators = [body('vehicle').isMongoId().withMessage('A valid vehicle is required')];

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

// The vehicle's photos, each with `image` set to a short-lived URL of the file in S3.
async function findActiveForVehicle(vehicleId) {
  const rows = await VehiclePhoto.find({ vehicle: vehicleId, isDeleted: false })
    .populate('vehicle', VEHICLE_POPULATE)
    .sort({ createdAt: 1 });
  return withFileUrls(rows, 'image');
}

// GET /api/vehicle-photos?vehicle=<id>
export const listVehiclePhotos = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  res.status(200).json({ data: await findActiveForVehicle(req.query.vehicle) });
});

// GET /api/vehicle-photos/:id
export const getVehiclePhoto = asyncHandler(async (req, res) => {
  const photo = await VehiclePhoto.findOne({ _id: req.params.id, isDeleted: false }).populate('vehicle', VEHICLE_POPULATE);
  if (!photo) {
    return res.status(404).json({ message: 'Photo not found' });
  }
  const [withUrl] = await withFileUrls([photo], 'image');
  res.status(200).json({ data: withUrl });
});

// POST /api/vehicle-photos (multipart/form-data: vehicle + any of front/back/passengerSide/driverSide,
// and up to 5 'additional' per request). A main-side upload replaces that side's previous photo;
// additional photos are appended, up to MAX_ADDITIONAL_PHOTOS per vehicle in total.
export const uploadVehiclePhotos = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const vehicle = await Vehicle.findOne({ _id: req.body.vehicle, isDeleted: false }, '_id vehicleNo make model');
  if (!vehicle) {
    return res.status(404).json({ message: 'Vehicle not found' });
  }

  const files = req.files || {};
  const mainUploads = MAIN_PHOTO_SLOTS.filter((slot) => files[slot]?.[0]).map((slot) => ({ slot, file: files[slot][0] }));
  const existingAdditional = await VehiclePhoto.countDocuments({ vehicle: vehicle._id, slot: 'additional', isDeleted: false });
  const additionalUploads = (files.additional || [])
    .slice(0, Math.max(MAX_ADDITIONAL_PHOTOS - existingAdditional, 0))
    .map((file) => ({ slot: 'additional', file }));

  if (!mainUploads.length && !additionalUploads.length) {
    return res.status(400).json({
      message: files.additional?.length
        ? `A vehicle can have at most ${MAX_ADDITIONAL_PHOTOS} additional photos`
        : 'Select at least one photo to upload',
    });
  }

  // Files go to S3 first, so a failed upload leaves the vehicle's current photos untouched.
  const uploads = [...mainUploads, ...additionalUploads];
  const keys = await Promise.all(
    uploads.map(({ slot, file }) => storeFile(file, objectKey(...vehiclePhotoKeyParts(vehicle, slot, file))))
  );

  if (mainUploads.length) {
    await VehiclePhoto.updateMany(
      { vehicle: vehicle._id, slot: { $in: mainUploads.map((u) => u.slot) }, isDeleted: false },
      { $set: { isDeleted: true } }
    );
  }
  await VehiclePhoto.insertMany(
    uploads.map(({ slot, file }, i) => ({
      vehicle: vehicle._id,
      slot,
      s3Key: keys[i],
      mimeType: file.mimetype,
      size: file.size,
    }))
  );

  res.status(200).json({ data: await findActiveForVehicle(vehicle._id), message: 'Photos uploaded successfully' });
});

// DELETE /api/vehicle-photos/:id — soft delete. Removing one of the 4 sides from an Active vehicle puts
// it On Hold (it can't be Active without them); `vehicleStatus` is the vehicle's status afterwards.
export const deleteVehiclePhoto = asyncHandler(async (req, res) => {
  const photo = await VehiclePhoto.findOne({ _id: req.params.id, isDeleted: false });
  if (!photo) {
    return res.status(404).json({ message: 'Photo not found' });
  }

  photo.isDeleted = true;
  await photo.save();
  const vehicleStatus = await holdIfIncomplete(photo.vehicle);
  res.status(200).json({
    data: await findActiveForVehicle(photo.vehicle),
    vehicleStatus,
    message: 'Photo removed successfully',
  });
});

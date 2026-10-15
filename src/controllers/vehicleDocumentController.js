import { body, query, validationResult } from 'express-validator';
import Vehicle from '../models/Vehicle.js';
import VehicleDocument, { VEHICLE_DOCUMENT_TYPES } from '../models/VehicleDocument.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { objectKey, storeFile, withFileUrls } from '../utils/storage.js';
import { vehicleDocumentFileName } from '../utils/fileNames.js';
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

// The vehicle's documents, each with `file` set to a short-lived URL of the file in S3.
async function findActiveForVehicle(vehicleId) {
  const rows = await VehicleDocument.find({ vehicle: vehicleId, isDeleted: false })
    .populate('vehicle', VEHICLE_POPULATE)
    .sort({ createdAt: 1 });
  return withFileUrls(rows, 'file');
}

// GET /api/vehicle-documents?vehicle=<id>
export const listVehicleDocuments = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;
  res.status(200).json({ data: await findActiveForVehicle(req.query.vehicle) });
});

// GET /api/vehicle-documents/:id
export const getVehicleDocument = asyncHandler(async (req, res) => {
  const document = await VehicleDocument.findOne({ _id: req.params.id, isDeleted: false }).populate(
    'vehicle',
    VEHICLE_POPULATE
  );
  if (!document) {
    return res.status(404).json({ message: 'Document not found' });
  }
  const [withUrl] = await withFileUrls([document], 'file');
  res.status(200).json({ data: withUrl });
});

// POST /api/vehicle-documents (multipart/form-data: vehicle + rc and/or insurance, image or PDF)
// Each uploaded type replaces that vehicle's previous document of the same type.
export const uploadVehicleDocuments = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const vehicle = await Vehicle.findOne({ _id: req.body.vehicle, isDeleted: false }, '_id vehicleNo make model');
  if (!vehicle) {
    return res.status(404).json({ message: 'Vehicle not found' });
  }

  const files = req.files || {};
  const uploads = VEHICLE_DOCUMENT_TYPES.filter((type) => files[type]?.[0]).map((type) => ({ type, file: files[type][0] }));
  if (!uploads.length) {
    return res.status(400).json({ message: 'Select at least one document to upload' });
  }

  // Files go to S3 first, so a failed upload leaves the vehicle's current documents untouched.
  const now = new Date();
  const named = uploads.map((u) => ({ ...u, fileName: vehicleDocumentFileName(vehicle, u.type, u.file, now) }));
  const keys = await Promise.all(
    named.map(({ file, fileName }) => storeFile(file, objectKey('vehicles', String(vehicle._id), 'documents', fileName)))
  );

  await VehicleDocument.updateMany(
    { vehicle: vehicle._id, type: { $in: uploads.map((u) => u.type) }, isDeleted: false },
    { $set: { isDeleted: true } }
  );
  await VehicleDocument.insertMany(
    named.map(({ type, file, fileName }, i) => ({
      vehicle: vehicle._id,
      type,
      s3Key: keys[i],
      mimeType: file.mimetype,
      size: file.size,
      fileName,
      originalName: file.originalname || '',
    }))
  );

  res.status(200).json({ data: await findActiveForVehicle(vehicle._id), message: 'Documents uploaded successfully' });
});

// DELETE /api/vehicle-documents/:id — soft delete. The RC and insurance are needed for a vehicle to be
// Active, so removing one from an Active vehicle puts it On Hold; `vehicleStatus` is the vehicle's
// status afterwards.
export const deleteVehicleDocument = asyncHandler(async (req, res) => {
  const document = await VehicleDocument.findOneAndUpdate(
    { _id: req.params.id, isDeleted: false },
    { isDeleted: true },
    { new: true }
  );
  if (!document) {
    return res.status(404).json({ message: 'Document not found' });
  }
  const vehicleStatus = await holdIfIncomplete(document.vehicle);
  res.status(200).json({
    data: await findActiveForVehicle(document.vehicle),
    vehicleStatus,
    message: 'Document removed successfully',
  });
});

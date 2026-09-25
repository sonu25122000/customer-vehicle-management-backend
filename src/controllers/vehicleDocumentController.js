import { body, query, validationResult } from 'express-validator';
import Vehicle from '../models/Vehicle.js';
import VehicleDocument, { VEHICLE_DOCUMENT_TYPES } from '../models/VehicleDocument.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toDataUri } from '../utils/media.js';

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

function findActiveForVehicle(vehicleId) {
  return VehicleDocument.find({ vehicle: vehicleId, isDeleted: false })
    .populate('vehicle', VEHICLE_POPULATE)
    .sort({ createdAt: 1 });
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
  res.status(200).json({ data: document });
});

// POST /api/vehicle-documents (multipart/form-data: vehicle + rc and/or insurance, image or PDF)
// Each uploaded type replaces that vehicle's previous document of the same type.
export const uploadVehicleDocuments = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const vehicle = await Vehicle.findOne({ _id: req.body.vehicle, isDeleted: false }, '_id');
  if (!vehicle) {
    return res.status(404).json({ message: 'Vehicle not found' });
  }

  const files = req.files || {};
  const uploads = VEHICLE_DOCUMENT_TYPES.filter((type) => files[type]?.[0]).map((type) => ({ type, file: files[type][0] }));
  if (!uploads.length) {
    return res.status(400).json({ message: 'Select at least one document to upload' });
  }

  await VehicleDocument.updateMany(
    { vehicle: vehicle._id, type: { $in: uploads.map((u) => u.type) }, isDeleted: false },
    { $set: { isDeleted: true } }
  );
  await VehicleDocument.insertMany(
    uploads.map(({ type, file }) => ({
      vehicle: vehicle._id,
      type,
      file: toDataUri(file),
      mimeType: file.mimetype,
      size: file.size,
    }))
  );

  res.status(200).json({ data: await findActiveForVehicle(vehicle._id), message: 'Documents uploaded successfully' });
});

// DELETE /api/vehicle-documents/:id — soft delete
export const deleteVehicleDocument = asyncHandler(async (req, res) => {
  const document = await VehicleDocument.findOneAndUpdate(
    { _id: req.params.id, isDeleted: false },
    { isDeleted: true },
    { new: true }
  );
  if (!document) {
    return res.status(404).json({ message: 'Document not found' });
  }
  res.status(200).json({ message: 'Document deleted successfully' });
});

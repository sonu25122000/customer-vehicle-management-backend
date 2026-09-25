import CustomerDocument from '../models/CustomerDocument.js';
import VehiclePhoto from '../models/VehiclePhoto.js';
import VehicleDocument from '../models/VehicleDocument.js';

// Uploaded files are held in memory by multer (see middleware/upload.js) and stored as base64 data URIs.
export function toDataUri(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

// customerId -> the document types on file (e.g. ['selfie', 'aadhaar']). Customer responses carry
// only this summary, never the files; the files come from /api/customer-documents.
export async function documentTypesByCustomer(customerIds) {
  if (!customerIds.length) return new Map();
  const rows = await CustomerDocument.aggregate([
    { $match: { customer: { $in: customerIds }, isDeleted: false } },
    { $group: { _id: '$customer', types: { $addToSet: '$type' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.types]));
}

// Which photo slots / document types a vehicle has on file, without loading the files. Vehicle
// responses carry this summary; the files come from /api/vehicle-photos and /api/vehicle-documents.
export async function vehicleMediaSummary(vehicleId) {
  const [photos, documentTypes] = await Promise.all([
    VehiclePhoto.find({ vehicle: vehicleId, isDeleted: false }, 'slot').lean(),
    VehicleDocument.distinct('type', { vehicle: vehicleId, isDeleted: false }),
  ]);
  return {
    photoSlots: [...new Set(photos.map((p) => p.slot))],
    photoCount: photos.length,
    documentTypes,
    documentCount: documentTypes.length,
  };
}

import CustomerDocument from '../models/CustomerDocument.js';
import VehiclePhoto from '../models/VehiclePhoto.js';
import VehicleDocument from '../models/VehicleDocument.js';
import Vehicle from '../models/Vehicle.js';

// customerId -> { types: ['selfie', 'aadhaar'], statuses: { selfie: 'Approved', aadhaar: 'Pending' } }
// for the documents on file. Customer responses carry only this summary, never the files; the files
// come from /api/customer-documents.
export async function documentSummaryByCustomer(customerIds) {
  if (!customerIds.length) return new Map();
  const rows = await CustomerDocument.aggregate([
    { $match: { customer: { $in: customerIds }, isDeleted: false } },
    { $group: { _id: '$customer', docs: { $push: { type: '$type', status: '$status' } } } },
  ]);
  return new Map(
    rows.map((r) => [
      String(r._id),
      {
        types: [...new Set(r.docs.map((d) => d.type))],
        statuses: Object.fromEntries(r.docs.map((d) => [d.type, d.status || 'Pending'])),
      },
    ])
  );
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

// Everything a vehicle needs on file before it can be Active: all 4 photo sides, the RC and the
// insurance. Shared by the status API (vehicleController.updateVehicleStatus) and the photo/document
// removal endpoints, which put an Active vehicle back On Hold once something on this list is removed.
const REQUIRED_FOR_ACTIVE = [
  { kind: 'photo', key: 'front', label: 'front photo' },
  { kind: 'photo', key: 'back', label: 'back photo' },
  { kind: 'photo', key: 'passengerSide', label: 'passenger side photo' },
  { kind: 'photo', key: 'driverSide', label: 'driver side photo' },
  { kind: 'document', key: 'rc', label: 'RC' },
  { kind: 'document', key: 'insurance', label: 'insurance' },
];

// Labels of whatever is still missing for the vehicle to be Active ([] when it can be).
export async function missingForActive(vehicleId) {
  const { photoSlots, documentTypes } = await vehicleMediaSummary(vehicleId);
  return REQUIRED_FOR_ACTIVE.filter((r) => !(r.kind === 'photo' ? photoSlots : documentTypes).includes(r.key)).map((r) => r.label);
}

export function isRequiredForActive(kind, key) {
  return REQUIRED_FOR_ACTIVE.some((r) => r.kind === kind && r.key === key);
}

// After a photo or document is removed: an Active vehicle that no longer has everything it needs goes
// On Hold. Returns the vehicle's status afterwards (null if the vehicle doesn't exist).
export async function holdIfIncomplete(vehicleId) {
  const vehicle = await Vehicle.findOne({ _id: vehicleId, isDeleted: false }, 'status');
  if (!vehicle) return null;
  if (vehicle.status === 'Active' && (await missingForActive(vehicleId)).length) {
    vehicle.status = 'On Hold';
    await vehicle.save();
  }
  return vehicle.status;
}

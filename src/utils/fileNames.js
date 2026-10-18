import crypto from 'crypto';

// Every uploaded document gets a predictable, searchable file name built from who/what it belongs to,
// what it is and when it was uploaded — never the name it happened to have on the uploader's device:
//
//   customer document: <NAME>_<MOBILE>_<TYPE>_<YYYYMMDD-HHmmss>.<ext>
//                      e.g. RAVI-KUMAR_9876543210_AADHAAR_20261015-103000.jpg
//   vehicle document:  <VEHICLENO>_<MAKE-MODEL>_<TYPE>_<YYYYMMDD-HHmmss>.<ext>
//                      e.g. KA01AB1234_MARUTI-BALENO_RC_20261015-103000.pdf
//   vehicle photo:     <STATE+RTO+NUMBER>_<Model>_<side>_image_<random>.<ext>
//                      e.g. KA533925_Baleno_front_image_9103299e.jpg for Baleno KA53MN3925 (the series
//                      letters are dropped; the random part tells apart photos of the same side)
//
// The names are only used for the stored file (its S3 object key), so files are easy to recognise in
// the bucket later — the apps never show them.
//
// The timestamp is in the business's local time (same offset bookings use) so it reads naturally.

const BUSINESS_UTC_OFFSET = process.env.BUSINESS_UTC_OFFSET || '+05:30';

const CUSTOMER_TYPE_CODES = { selfie: 'SELFIE', drivingLicence: 'DL', aadhaar: 'AADHAAR', aadhaarBack: 'AADHAAR-BACK', other: 'OTHER' };
const VEHICLE_TYPE_CODES = { rc: 'RC', insurance: 'INSURANCE' };
const PHOTO_SLOT_CODES = { front: 'front', back: 'back', passengerSide: 'passenger_side', driverSide: 'driver_side', additional: 'additional' };
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

function offsetMinutes(offset) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

// 'YYYYMMDD-HHmmss' in business local time.
export function fileTimestamp(date = new Date()) {
  const local = new Date(date.getTime() + offsetMinutes(BUSINESS_UTC_OFFSET) * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}` +
    `-${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}`
  );
}

// Upper-case, letters/digits only, words joined by '-', capped so names stay short.
function slug(value, max = 24) {
  return (
    String(value || '')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toUpperCase()
      .slice(0, max)
      .replace(/-+$/, '') || 'UNKNOWN'
  );
}

function extensionFor(file) {
  if (EXTENSIONS[file.mimetype]) return EXTENSIONS[file.mimetype];
  const fromName = /\.([A-Za-z0-9]{1,5})$/.exec(file.originalname || '');
  return fromName ? fromName[1].toLowerCase() : 'bin';
}

export function customerDocumentFileName(customer, type, file, date = new Date()) {
  const code = CUSTOMER_TYPE_CODES[type] || slug(type);
  return `${slug(customer.name)}_${customer.mobile1 || 'NOMOBILE'}_${code}_${fileTimestamp(date)}.${extensionFor(file)}`;
}

// <NAME>_<MOBILE>_PROFILE_<YYYYMMDD-HHmmss>.<ext> — a customer's profile picture.
export function customerProfilePhotoFileName(customer, file, date = new Date()) {
  return `${slug(customer.name)}_${customer.mobile1 || 'NOMOBILE'}_PROFILE_${fileTimestamp(date)}.${extensionFor(file)}`;
}

export function vehicleDocumentFileName(vehicle, type, file, date = new Date()) {
  const code = VEHICLE_TYPE_CODES[type] || slug(type);
  const makeModel = slug([vehicle.make, vehicle.model].filter(Boolean).join(' '));
  return `${vehicle.vehicleNo}_${makeModel}_${code}_${fileTimestamp(date)}.${extensionFor(file)}`;
}

// KA53MN3925 -> KA533925: state + RTO code + number, without the series letters.
function shortVehicleNo(vehicleNo) {
  const match = /^([A-Z]{2}\d{1,2})[A-Z]{0,3}(\d{1,4})$/.exec(String(vehicleNo || '').toUpperCase());
  return match ? match[1] + match[2] : slug(vehicleNo);
}

// Letters/digits of the model, words joined by '-', in its own case (e.g. Baleno, Grand-Vitara).
function modelName(model) {
  return (
    String(model || '')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'Car'
  );
}

export function vehiclePhotoFileName(vehicle, slot, file) {
  const side = PHOTO_SLOT_CODES[slot] || slug(slot).toLowerCase();
  const random = crypto.randomBytes(4).toString('hex');
  return `${shortVehicleNo(vehicle.vehicleNo)}_${modelName(vehicle.model)}_${side}_image_${random}.${extensionFor(file)}`;
}

// ---- Folders in the S3 bucket ----
// Files are grouped by the vehicle / customer they belong to, then by what they are, so the bucket can
// be browsed by hand (after the optional S3_PREFIX folder):
//
//   vehicles/KA53MN3925/photos/KA533925_Baleno_front_image_9103299e.jpg
//   vehicles/KA53MN3925/documents/rc/KA53MN3925_MARUTI-BALENO_RC_20261015-103000.pdf
//   vehicles/KA53MN3925/documents/insurance/...
//   customers/9876543210_RAVI-KUMAR/documents/aadhaar/RAVI-KUMAR_9876543210_AADHAAR_20261015-103000.jpg
//   customers/9876543210_RAVI-KUMAR/documents/driving-licence/...
//   customers/9876543210_RAVI-KUMAR/documents/selfie/...
//   customers/9876543210_RAVI-KUMAR/profile-photo/RAVI-KUMAR_9876543210_PROFILE_20261015-103000.jpg
//
// Each row stores its own full key (s3Key), so a later rename of the customer or vehicle only changes
// where new files go — files already uploaded stay readable where they are.

const CUSTOMER_TYPE_FOLDERS = { selfie: 'selfie', drivingLicence: 'driving-licence', aadhaar: 'aadhaar', aadhaarBack: 'aadhaar-back', other: 'other' };

function vehicleFolder(vehicle) {
  return ['vehicles', slug(vehicle.vehicleNo, 16)];
}

function customerFolder(customer) {
  return ['customers', `${customer.mobile1 || 'NOMOBILE'}_${slug(customer.name)}`];
}

// The parts of an object key (folders + file name), for storage.objectKey(...).
export function vehiclePhotoKeyParts(vehicle, slot, file) {
  return [...vehicleFolder(vehicle), 'photos', vehiclePhotoFileName(vehicle, slot, file)];
}

export function vehicleDocumentKeyParts(vehicle, type, fileName) {
  return [...vehicleFolder(vehicle), 'documents', String(type).toLowerCase(), fileName];
}

export function customerDocumentKeyParts(customer, type, fileName) {
  return [...customerFolder(customer), 'documents', CUSTOMER_TYPE_FOLDERS[type] || slug(type).toLowerCase(), fileName];
}

export function customerProfilePhotoKeyParts(customer, fileName) {
  return [...customerFolder(customer), 'profile-photo', fileName];
}

// Every uploaded document gets a predictable, searchable file name built from who/what it belongs to,
// what it is and when it was uploaded — never the name it happened to have on the uploader's device:
//
//   customer document: <NAME>_<MOBILE>_<TYPE>_<YYYYMMDD-HHmmss>.<ext>
//                      e.g. RAVI-KUMAR_9876543210_AADHAAR_20261015-103000.jpg
//   vehicle document:  <VEHICLENO>_<MAKE-MODEL>_<TYPE>_<YYYYMMDD-HHmmss>.<ext>
//                      e.g. KA01AB1234_MARUTI-BALENO_RC_20261015-103000.pdf
//
// The timestamp is in the business's local time (same offset bookings use) so it reads naturally.

const BUSINESS_UTC_OFFSET = process.env.BUSINESS_UTC_OFFSET || '+05:30';

const CUSTOMER_TYPE_CODES = { selfie: 'SELFIE', drivingLicence: 'DL', aadhaar: 'AADHAAR', other: 'OTHER' };
const VEHICLE_TYPE_CODES = { rc: 'RC', insurance: 'INSURANCE' };
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

export function vehicleDocumentFileName(vehicle, type, file, date = new Date()) {
  const code = VEHICLE_TYPE_CODES[type] || slug(type);
  const makeModel = slug([vehicle.make, vehicle.model].filter(Boolean).join(' '));
  return `${vehicle.vehicleNo}_${makeModel}_${code}_${fileTimestamp(date)}.${extensionFor(file)}`;
}

import multer from 'multer';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOCUMENT_TYPES = new Set([...IMAGE_TYPES, 'application/pdf']);

// Files are held in memory and converted to base64 for storage directly on the Mongo
// document (no filesystem/object storage configured). The frontend compresses every image
// down to ~1-1.5MB before it ever reaches this middleware (see utils/compressImage.js) —
// this limit is the hard backstop: anything still over it (a large PDF, or compression
// failing for any reason) is rejected rather than stored, keeping embedded files well under
// MongoDB's 16MB per-document limit.
const PHOTO_MAX_BYTES = 1.5 * 1024 * 1024; // 1.5MB per vehicle photo, post client-side compression
const DOCUMENT_MAX_BYTES = 1.5 * 1024 * 1024; // 1.5MB per customer document

function fileFilterFor(allowedTypes) {
  return (req, file, cb) => {
    if (!allowedTypes.has(file.mimetype)) {
      return cb(new Error('Unsupported file type'));
    }
    cb(null, true);
  };
}

export const uploadVehiclePhotos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_MAX_BYTES },
  fileFilter: fileFilterFor(IMAGE_TYPES),
}).fields([
  { name: 'front', maxCount: 1 },
  { name: 'back', maxCount: 1 },
  { name: 'passengerSide', maxCount: 1 },
  { name: 'driverSide', maxCount: 1 },
  { name: 'additional', maxCount: 5 },
]);

export const uploadCustomerDocuments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOCUMENT_MAX_BYTES },
  fileFilter: fileFilterFor(DOCUMENT_TYPES),
}).fields([
  { name: 'selfie', maxCount: 1 },
  { name: 'drivingLicence', maxCount: 1 },
  { name: 'aadhaar', maxCount: 1 },
  { name: 'other', maxCount: 1 },
]);

export const uploadVehicleDocuments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOCUMENT_MAX_BYTES },
  fileFilter: fileFilterFor(DOCUMENT_TYPES),
}).fields([
  { name: 'rc', maxCount: 1 },
  { name: 'insurance', maxCount: 1 },
]);

export function handleUploadErrors(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: 'File is too large (max 1.5MB after compression)' });
    }
    return res.status(400).json({ message: err.message });
  }
  if (err) {
    return res.status(400).json({ message: err.message || 'Upload failed' });
  }
  next();
}

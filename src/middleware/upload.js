import multer from 'multer';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOCUMENT_TYPES = new Set([...IMAGE_TYPES, 'application/pdf']);

// Files are held in memory just long enough to be uploaded to S3 (utils/storage.js). Every file is
// capped at 2MB. The apps compress images below that before uploading (utils/compressImage.js) and
// send one file per request, which keeps each request under the hosting platform's body limit (4.5MB
// on Vercel); this limit is the hard backstop for anything still over it (e.g. a large PDF).
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PHOTO_MAX_BYTES = MAX_FILE_BYTES;
const DOCUMENT_MAX_BYTES = MAX_FILE_BYTES;

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

export const uploadProfilePhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_MAX_BYTES },
  fileFilter: fileFilterFor(IMAGE_TYPES),
}).single('photo');

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
      return res.status(400).json({ message: 'File is too large — the maximum is 2 MB' });
    }
    return res.status(400).json({ message: err.message });
  }
  if (err) {
    return res.status(400).json({ message: err.message || 'Upload failed' });
  }
  next();
}

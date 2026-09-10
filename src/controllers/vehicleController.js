import { body, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import Trip from '../models/Trip.js';
import { asyncHandler } from '../utils/asyncHandler.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

export const VEHICLE_TYPES = ['Car', 'Bike', 'Scooty'];
export const CATEGORY_MAP = {
  Car: ['Sedan', 'Hatchback', 'SUV', 'Compact'],
  Bike: ['Sports', 'Cruiser', 'Commuter', 'Off-Road'],
  Scooty: ['Standard', 'Electric', 'Gearless'],
};
export const MAKE_MAP = {
  Car: [
    'Maruti Suzuki', 'Hyundai', 'Tata', 'Mahindra', 'Honda', 'Toyota', 'Kia',
    'Ford', 'Volkswagen', 'BMW', 'Mercedes-Benz', 'Audi', 'Renault', 'Nissan', 'Skoda',
  ],
  Bike: ['Royal Enfield', 'Bajaj', 'Hero MotoCorp', 'TVS', 'Yamaha', 'Honda', 'Suzuki', 'KTM', 'Kawasaki', 'Harley-Davidson'],
  Scooty: ['Honda', 'TVS', 'Bajaj', 'Suzuki', 'Hero MotoCorp', 'Yamaha', 'Ather', 'Ola Electric', 'Vespa', 'Aprilia'],
};
// Model options depend on Make — same cross-field pattern as vehicleCategory/make depending on
// vehicleType. Not exhaustive, just enough real-world models per make for the dropdown to be useful.
export const MODEL_MAP = {
  'Maruti Suzuki': ['Swift', 'Baleno', 'Dzire', 'WagonR', 'Alto', 'Ertiga', 'Brezza'],
  Hyundai: ['i10', 'i20', 'Venue', 'Creta', 'Verna', 'Aura'],
  Tata: ['Nexon', 'Punch', 'Tiago', 'Altroz', 'Harrier', 'Safari'],
  Mahindra: ['XUV700', 'Scorpio', 'Bolero', 'Thar', 'XUV300'],
  Honda: ['City', 'Amaze', 'Activa', 'Shine', 'Unicorn'],
  Toyota: ['Innova', 'Fortuner', 'Glanza', 'Urban Cruiser'],
  Kia: ['Seltos', 'Sonet', 'Carens'],
  Ford: ['EcoSport', 'Figo', 'Endeavour'],
  Volkswagen: ['Polo', 'Vento', 'Taigun'],
  BMW: ['3 Series', '5 Series', 'X1'],
  'Mercedes-Benz': ['C-Class', 'E-Class', 'GLA'],
  Audi: ['A4', 'A6', 'Q3'],
  Renault: ['Kwid', 'Triber', 'Kiger'],
  Nissan: ['Magnite', 'Kicks'],
  Skoda: ['Rapid', 'Octavia', 'Kushaq'],
  'Royal Enfield': ['Classic 350', 'Bullet 350', 'Meteor 350', 'Hunter 350'],
  Bajaj: ['Pulsar', 'Avenger', 'Platina', 'CT100'],
  'Hero MotoCorp': ['Splendor', 'Passion', 'Glamour', 'HF Deluxe'],
  TVS: ['Apache', 'Raider', 'Sport', 'Jupiter', 'Ntorq'],
  Yamaha: ['FZ', 'R15', 'MT-15', 'Fascino'],
  Suzuki: ['Gixxer', 'Access', 'Burgman'],
  KTM: ['Duke 200', 'Duke 390', 'RC 200'],
  Kawasaki: ['Ninja 300', 'Ninja 650', 'Splendor'],
  'Harley-Davidson': ['Street 750', 'Iron 883'],
  Ather: ['450X', '450S'],
  'Ola Electric': ['S1 Pro', 'S1 Air'],
  Vespa: ['VXL', 'SXL'],
  Aprilia: ['SR 160', 'SXR 160'],
};
export const TRANSMISSIONS = ['Manual', 'Automatic'];
export const FUEL_TYPES = ['Petrol', 'Diesel', 'CNG', 'Electric'];
export const VEHICLE_STATUSES = ['Active', 'In Hold', 'Inactive'];
const VEHICLE_NO_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,2}[0-9]{4}$/;

export const listValidators = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('minRating').optional({ checkFalsy: true }).isInt({ min: 1, max: 5 }).toInt(),
  query('startDate').optional({ checkFalsy: true }).isISO8601().withMessage('Invalid start date'),
  query('endDate').optional({ checkFalsy: true }).isISO8601().withMessage('Invalid end date'),
  query('customerIds')
    .optional({ checkFalsy: true })
    .custom((value) => {
      const ids = String(value).split(',').filter(Boolean);
      if (!ids.every((id) => OBJECT_ID_RE.test(id))) {
        throw new Error('Invalid customer selection');
      }
      return true;
    }),
];

export const vehicleValidators = [
  body('vehicleNo')
    .trim()
    .notEmpty()
    .withMessage('Vehicle number is required')
    .customSanitizer((value) => value.toUpperCase())
    .matches(VEHICLE_NO_RE)
    .withMessage('Enter a valid vehicle number (e.g. KA01AB1234)'),
  body('vehicleType').trim().notEmpty().withMessage('Vehicle type is required').isIn(VEHICLE_TYPES).withMessage('Invalid vehicle type'),
  body('vehicleCategory')
    .trim()
    .notEmpty()
    .withMessage('Vehicle category is required')
    .custom((value, { req }) => {
      const allowed = CATEGORY_MAP[req.body.vehicleType] || [];
      if (!allowed.includes(value)) {
        throw new Error('Vehicle category does not match the selected vehicle type');
      }
      return true;
    }),
  body('make')
    .optional({ checkFalsy: true })
    .trim()
    .custom((value, { req }) => {
      const allowed = MAKE_MAP[req.body.vehicleType] || [];
      if (!allowed.includes(value)) {
        throw new Error('Selected make does not match the selected vehicle type');
      }
      return true;
    }),
  body('model')
    .optional({ checkFalsy: true })
    .trim()
    .custom((value, { req }) => {
      const allowed = MODEL_MAP[req.body.make] || [];
      if (!allowed.includes(value)) {
        throw new Error('Selected model does not match the selected make');
      }
      return true;
    }),
  body('transmission')
    .trim()
    .notEmpty()
    .withMessage('Transmission is required')
    .isIn(TRANSMISSIONS)
    .withMessage('Invalid transmission'),
  body('fuel').trim().notEmpty().withMessage('Fuel type is required').isIn(FUEL_TYPES).withMessage('Invalid fuel type'),
  body('status').optional({ checkFalsy: true }).isIn(VEHICLE_STATUSES).withMessage('Invalid vehicle status'),
  body('ownerName').trim().notEmpty().withMessage('Owner/Customer name is required'),
  body('ownerMobile')
    .trim()
    .notEmpty()
    .withMessage('Owner mobile is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Owner mobile must be exactly 10 digits'),
];

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

// Shared aggregation stages: attach trip-derived stats (tripsCompleted / ratingsGiven /
// avgRating) without ever shipping actual photo data in the list payload.
function tripStatsStages() {
  return [
    {
      $lookup: {
        from: 'trips',
        let: { vehicleId: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$vehicle', '$$vehicleId'] }, { $eq: ['$isDeleted', false] }] } } },
          { $project: { status: 1, rating: 1 } },
        ],
        as: 'vehicleTrips',
      },
    },
    {
      $addFields: {
        tripsCompleted: {
          $size: { $filter: { input: '$vehicleTrips', cond: { $eq: ['$$this.status', 'Completed'] } } },
        },
        // Rating is always 1-5 when set — checking membership avoids the missing-vs-null
        // ambiguity that $ne: [field, null] doesn't reliably resolve for absent fields.
        ratedTrips: { $filter: { input: '$vehicleTrips', cond: { $in: ['$$this.rating', [1, 2, 3, 4, 5]] } } },
      },
    },
    {
      $addFields: {
        ratingsGiven: { $size: '$ratedTrips' },
        avgRating: { $ifNull: [{ $round: [{ $avg: '$ratedTrips.rating' }, 1] }, 0] },
      },
    },
  ];
}

// GET /api/vehicles?search=&page=&limit=&startDate=&endDate=&customerIds=
export const listVehicles = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const page = req.query.page || 1;
  const limit = req.query.limit || 10;
  const search = (req.query.search || '').trim();
  const { startDate, endDate, customerIds, minRating } = req.query;

  const filter = { isDeleted: false };
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [
      { vehicleNo: regex },
      { ownerName: regex },
      { ownerMobile: regex },
      { make: regex },
      { model: regex },
      { vehicleCategory: regex },
      { transmission: regex },
      { fuel: regex },
      { status: regex },
    ];
  }
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }
  if (customerIds) {
    const ids = String(customerIds).split(',').filter(Boolean);
    if (ids.length) {
      // Vehicle no longer links directly to a Customer — ownership now flows through Trip.
      const tripVehicleIds = await Trip.distinct('vehicle', {
        customer: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
        isDeleted: false,
      });
      filter._id = { $in: tripVehicleIds };
    }
  }

  // avgRating only exists after tripStatsStages() runs, so filtering by minRating has to happen
  // before pagination (not after) — otherwise both the page contents and the total count would
  // be wrong. That means trip stats get computed for every matching vehicle, not just the page's
  // worth, which is an acceptable cost at this app's scale.
  const basePipeline = [{ $match: filter }, ...tripStatsStages()];
  if (minRating) basePipeline.push({ $match: { avgRating: { $gte: minRating } } });

  // Photo data (base64 data URIs) is intentionally excluded from the list payload — it can run
  // into the megabytes per vehicle. photoCount/trip stats are computed in the aggregation so
  // the table can still show accurate badges without shipping the actual images.
  const [vehicles, countResult] = await Promise.all([
    Vehicle.aggregate([
      ...basePipeline,
      { $sort: { createdAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $project: {
          vehicleNo: 1,
          vehicleType: 1,
          vehicleCategory: 1,
          transmission: 1,
          fuel: 1,
          status: 1,
          make: 1,
          model: 1,
          ownerName: 1,
          ownerMobile: 1,
          isDeleted: 1,
          createdAt: 1,
          updatedAt: 1,
          tripsCompleted: 1,
          ratingsGiven: 1,
          avgRating: 1,
          photoCount: {
            $add: [
              { $cond: [{ $ne: [{ $ifNull: ['$photos.front', ''] }, ''] }, 1, 0] },
              { $cond: [{ $ne: [{ $ifNull: ['$photos.back', ''] }, ''] }, 1, 0] },
              { $cond: [{ $ne: [{ $ifNull: ['$photos.passengerSide', ''] }, ''] }, 1, 0] },
              { $cond: [{ $ne: [{ $ifNull: ['$photos.driverSide', ''] }, ''] }, 1, 0] },
              { $size: { $ifNull: ['$photos.additional', []] } },
            ],
          },
          documentCount: {
            $add: [
              { $cond: [{ $ne: [{ $ifNull: ['$documents.rc', ''] }, ''] }, 1, 0] },
              { $cond: [{ $ne: [{ $ifNull: ['$documents.insurance', ''] }, ''] }, 1, 0] },
            ],
          },
        },
      },
    ]),
    Vehicle.aggregate([...basePipeline, { $count: 'total' }]),
  ]);
  const total = countResult[0]?.total || 0;

  res.status(200).json({
    data: vehicles,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    },
  });
});

// GET /api/vehicles/stats — Total / On Trip / Available, for the Vehicles page stat tiles
export const getVehicleStats = asyncHandler(async (req, res) => {
  const total = await Vehicle.countDocuments({ isDeleted: false });
  const onTripVehicleIds = await Trip.distinct('vehicle', { isDeleted: false, status: 'On Trip' });
  const onTrip = onTripVehicleIds.length;
  res.status(200).json({ data: { total, onTrip, available: Math.max(total - onTrip, 0) } });
});

// GET /api/vehicles/options?activeOnly=true — lightweight vehicle-picker list.
// activeOnly (used by the Trip form) additionally excludes vehicles with status other than
// "Active" and vehicles currently on another active trip — picking either would just bounce
// back as a validation/409 error, so they're filtered out proactively instead.
export const listVehicleOptions = asyncHandler(async (req, res) => {
  const filter = { isDeleted: false };

  if (req.query.activeOnly === 'true') {
    filter.status = 'Active';
    const onTripVehicleIds = await Trip.distinct('vehicle', { isDeleted: false, status: 'On Trip' });
    if (onTripVehicleIds.length) filter._id = { $nin: onTripVehicleIds };
  }

  const vehicles = await Vehicle.find(
    filter,
    'vehicleNo ownerName vehicleType vehicleCategory transmission fuel status make model'
  )
    .sort({ vehicleNo: 1 })
    .limit(1000);
  res.status(200).json({ data: vehicles });
});

// GET /api/vehicles/:id
export const getVehicle = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.id);
  if (!vehicle) {
    return res.status(404).json({ message: 'Vehicle not found' });
  }

  const [stats] = await Vehicle.aggregate([
    { $match: { _id: vehicle._id } },
    ...tripStatsStages(),
    { $project: { tripsCompleted: 1, ratingsGiven: 1, avgRating: 1 } },
  ]);

  res.status(200).json({
    data: {
      ...vehicle.toObject(),
      tripsCompleted: stats?.tripsCompleted || 0,
      ratingsGiven: stats?.ratingsGiven || 0,
      avgRating: stats?.avgRating || 0,
    },
  });
});

async function findDuplicate(vehicleNo, excludeId) {
  const filter = { vehicleNo: vehicleNo.trim().toUpperCase(), isDeleted: false };
  if (excludeId) filter._id = { $ne: excludeId };
  return Vehicle.findOne(filter);
}

// POST /api/vehicles
export const createVehicle = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { vehicleNo, vehicleType, vehicleCategory, transmission, fuel, status, make, model, ownerName, ownerMobile } =
    req.body;

  const duplicate = await findDuplicate(vehicleNo);
  if (duplicate) {
    return res.status(409).json({ message: 'A vehicle with this vehicle number already exists' });
  }

  const vehicle = await Vehicle.create({
    vehicleNo,
    vehicleType,
    vehicleCategory,
    transmission,
    fuel,
    status: status || undefined,
    make,
    model,
    ownerName,
    ownerMobile,
  });
  res.status(201).json({ data: vehicle, message: 'Vehicle created successfully' });
});

// PUT/PATCH /api/vehicles/:id
export const updateVehicle = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { vehicleNo, vehicleType, vehicleCategory, transmission, fuel, status, make, model, ownerName, ownerMobile } =
    req.body;

  const duplicate = await findDuplicate(vehicleNo, req.params.id);
  if (duplicate) {
    return res.status(409).json({ message: 'A vehicle with this vehicle number already exists' });
  }

  const vehicle = await Vehicle.findOneAndUpdate(
    { _id: req.params.id, isDeleted: false },
    { vehicleNo, vehicleType, vehicleCategory, transmission, fuel, status: status || 'In Hold', make, model, ownerName, ownerMobile },
    { new: true, runValidators: true }
  );

  if (!vehicle) {
    return res.status(404).json({ message: 'Vehicle not found' });
  }

  res.status(200).json({ data: vehicle, message: 'Vehicle updated successfully' });
});

// DELETE /api/vehicles/:id — soft delete
export const deleteVehicle = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findOneAndUpdate(
    { _id: req.params.id, isDeleted: false },
    { isDeleted: true },
    { new: true }
  );
  if (!vehicle) {
    return res.status(404).json({ message: 'Vehicle not found' });
  }
  res.status(200).json({ message: 'Vehicle deleted successfully' });
});

const PHOTO_FIELDS = ['front', 'back', 'passengerSide', 'driverSide'];

function toDataUri(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

// POST /api/vehicles/:id/photos (multipart/form-data)
export const uploadVehiclePhotos = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findOne({ _id: req.params.id, isDeleted: false });
  if (!vehicle) {
    return res.status(404).json({ message: 'Vehicle not found' });
  }

  const files = req.files || {};

  for (const field of PHOTO_FIELDS) {
    if (files[field]?.[0]) {
      vehicle.photos[field] = toDataUri(files[field][0]);
    }
  }

  if (files.additional?.length) {
    const newOnes = files.additional.map(toDataUri);
    vehicle.photos.additional = [...vehicle.photos.additional, ...newOnes].slice(0, 10);
  }

  await vehicle.save();
  res.status(200).json({ data: vehicle, message: 'Photos uploaded successfully' });
});

// DELETE /api/vehicles/:id/photos/:slot — remove a single photo (main slot, or "additional:<index>")
export const deleteVehiclePhoto = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findOne({ _id: req.params.id, isDeleted: false });
  if (!vehicle) {
    return res.status(404).json({ message: 'Vehicle not found' });
  }

  const { slot } = req.params;
  if (PHOTO_FIELDS.includes(slot)) {
    vehicle.photos[slot] = '';
  } else if (slot.startsWith('additional:')) {
    const index = Number(slot.split(':')[1]);
    vehicle.photos.additional.splice(index, 1);
  } else {
    return res.status(400).json({ message: 'Invalid photo slot' });
  }

  await vehicle.save();
  res.status(200).json({ data: vehicle, message: 'Photo removed successfully' });
});

const DOCUMENT_FIELDS = ['rc', 'insurance'];

// POST /api/vehicles/:id/documents (multipart/form-data) — RC / Insurance, image or PDF
export const uploadVehicleDocuments = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findOne({ _id: req.params.id, isDeleted: false });
  if (!vehicle) {
    return res.status(404).json({ message: 'Vehicle not found' });
  }

  const files = req.files || {};
  for (const field of DOCUMENT_FIELDS) {
    if (files[field]?.[0]) {
      vehicle.documents[field] = toDataUri(files[field][0]);
    }
  }

  await vehicle.save();
  res.status(200).json({ data: vehicle, message: 'Documents uploaded successfully' });
});

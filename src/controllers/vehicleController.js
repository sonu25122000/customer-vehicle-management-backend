import { body, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import Trip from '../models/Trip.js';
import VehicleCatalog from '../models/VehicleCatalog.js';
import VehiclePhoto, { MAIN_PHOTO_SLOTS } from '../models/VehiclePhoto.js';
import VehicleDocument from '../models/VehicleDocument.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { vehicleMediaSummary } from '../utils/media.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// Vehicle type, category, make and model options used to be hardcoded here (VEHICLE_TYPES/
// CATEGORY_MAP/MAKE_MAP/MODEL_MAP) — they're now admin-managed data in the single VehicleCatalog
// document (see vehicleCatalogController.js), editable from the "Vehicle Catalog" tab.
export const TRANSMISSIONS = ['Manual', 'Automatic'];
export const FUEL_TYPES = ['Petrol', 'Diesel', 'CNG', 'Electric'];
export const VEHICLE_STATUSES = ['Active', 'On Hold', 'Inactive'];
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
  body('vehicleType')
    .trim()
    .notEmpty()
    .withMessage('Vehicle type is required')
    .custom(async (value) => {
      const match = await VehicleCatalog.findOne({
        vehicleTypes: { $elemMatch: { name: value, isDeleted: false } },
      });
      if (!match) {
        throw new Error('Invalid vehicle type');
      }
      return true;
    }),
  body('vehicleCategory')
    .trim()
    .notEmpty()
    .withMessage('Vehicle category is required')
    .custom(async (value, { req }) => {
      const match = await VehicleCatalog.findOne({
        vehicleTypes: {
          $elemMatch: {
            name: req.body.vehicleType,
            isDeleted: false,
            categories: { $elemMatch: { name: value, isDeleted: false } },
          },
        },
      });
      if (!match) {
        throw new Error('Vehicle category does not match the selected vehicle type');
      }
      return true;
    }),
  body('make')
    .trim()
    .notEmpty()
    .withMessage('Make is required')
    .custom(async (value, { req }) => {
      const match = await VehicleCatalog.findOne({
        vehicleTypes: {
          $elemMatch: {
            name: req.body.vehicleType,
            isDeleted: false,
            makes: { $elemMatch: { name: value, isDeleted: false } },
          },
        },
      });
      if (!match) {
        throw new Error('Selected make does not match the selected vehicle type');
      }
      return true;
    }),
  body('model')
    .trim()
    .notEmpty()
    .withMessage('Model is required')
    .custom(async (value, { req }) => {
      const match = await VehicleCatalog.findOne({
        vehicleTypes: {
          $elemMatch: {
            name: req.body.vehicleType,
            isDeleted: false,
            makes: {
              $elemMatch: {
                name: req.body.make,
                isDeleted: false,
                models: { $elemMatch: { name: value, isDeleted: false } },
              },
            },
          },
        },
      });
      if (!match) {
        throw new Error('Selected model does not match the selected make');
      }
      return true;
    }),
  body('year')
    .notEmpty()
    .withMessage('Year is required')
    .isInt({ min: 1990, max: new Date().getFullYear() + 1 })
    .withMessage(`Year must be between 1990 and ${new Date().getFullYear() + 1}`)
    .toInt(),
  body('transmission')
    .trim()
    .notEmpty()
    .withMessage('Transmission is required')
    .isIn(TRANSMISSIONS)
    .withMessage('Invalid transmission'),
  body('fuel').trim().notEmpty().withMessage('Fuel type is required').isIn(FUEL_TYPES).withMessage('Invalid fuel type'),
  body('status').optional({ checkFalsy: true }).isIn(VEHICLE_STATUSES).withMessage('Invalid vehicle status'),
  body('ownerName').trim().notEmpty().withMessage('Owner/Host name is required'),
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

// Number of active rows in a media collection (VehiclePhoto / VehicleDocument) for each vehicle,
// counted without loading the files themselves.
function mediaCountStages(collectionName, as) {
  return [
    {
      $lookup: {
        from: collectionName,
        let: { vehicleId: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$vehicle', '$$vehicleId'] }, { $eq: ['$isDeleted', false] }] } } },
          { $count: 'n' },
        ],
        as,
      },
    },
    { $addFields: { [as]: { $ifNull: [{ $arrayElemAt: [`$${as}.n`, 0] }, 0] } } },
  ];
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

  // Photos and documents live in their own collections (VehiclePhoto / VehicleDocument), so the list
  // never carries file data. photoCount/documentCount are counted for just this page's vehicles so the
  // table can still show accurate badges.
  const [vehicles, countResult] = await Promise.all([
    Vehicle.aggregate([
      ...basePipeline,
      { $sort: { createdAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      ...mediaCountStages(VehiclePhoto.collection.name, 'photoCount'),
      ...mediaCountStages(VehicleDocument.collection.name, 'documentCount'),
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
          year: 1,
          ownerName: 1,
          ownerMobile: 1,
          isDeleted: 1,
          createdAt: 1,
          updatedAt: 1,
          tripsCompleted: 1,
          ratingsGiven: 1,
          avgRating: 1,
          photoCount: 1,
          documentCount: 1,
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

// GET /api/vehicles/stats — Total / Active / On Hold / On Trip / Available, for the Vehicles page stat tiles
export const getVehicleStats = asyncHandler(async (_req, res) => {
  const [total, active, onHold, onTripVehicleIds] = await Promise.all([
    Vehicle.countDocuments({ isDeleted: false }),
    Vehicle.countDocuments({ isDeleted: false, status: 'Active' }),
    Vehicle.countDocuments({ isDeleted: false, status: 'On Hold' }),
    Trip.distinct('vehicle', { isDeleted: false, status: 'On Trip' }),
  ]);
  const onTrip = onTripVehicleIds.length;
  res.status(200).json({ data: { total, active, onHold, onTrip, available: Math.max(total - onTrip, 0) } });
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
    'vehicleNo ownerName vehicleType vehicleCategory transmission fuel status make model year'
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

  const [[stats], media] = await Promise.all([
    Vehicle.aggregate([
      { $match: { _id: vehicle._id } },
      ...tripStatsStages(),
      { $project: { tripsCompleted: 1, ratingsGiven: 1, avgRating: 1 } },
    ]),
    vehicleMediaSummary(vehicle._id),
  ]);

  res.status(200).json({
    data: {
      ...vehicle.toObject(),
      ...media,
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

// A vehicle can only go Active once all 4 photo sides are on file — a freshly created vehicle
// never has any yet, so it can never be created Active either.
async function hasAllPhotoSides(vehicleId) {
  const slots = await VehiclePhoto.distinct('slot', { vehicle: vehicleId, isDeleted: false });
  return MAIN_PHOTO_SLOTS.every((slot) => slots.includes(slot));
}

// POST /api/vehicles
export const createVehicle = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { vehicleNo, vehicleType, vehicleCategory, transmission, fuel, make, model, year, ownerName, ownerMobile } = req.body;

  const duplicate = await findDuplicate(vehicleNo);
  if (duplicate) {
    return res.status(409).json({ message: 'A vehicle with this vehicle number already exists' });
  }

  // A new vehicle always starts "On Hold" — never accept an initial status from the client
  // (the schema default applies), matching the create form which only offers that one option.
  const vehicle = await Vehicle.create({
    vehicleNo,
    vehicleType,
    vehicleCategory,
    transmission,
    fuel,
    make,
    model,
    year,
    ownerName,
    ownerMobile,
  });
  res.status(201).json({ data: vehicle, message: 'Vehicle created successfully' });
});

// PUT/PATCH /api/vehicles/:id
export const updateVehicle = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { vehicleNo, vehicleType, vehicleCategory, transmission, fuel, status, make, model, year, ownerName, ownerMobile } =
    req.body;

  const duplicate = await findDuplicate(vehicleNo, req.params.id);
  if (duplicate) {
    return res.status(409).json({ message: 'A vehicle with this vehicle number already exists' });
  }

  const vehicle = await Vehicle.findOne({ _id: req.params.id, isDeleted: false });
  if (!vehicle) {
    return res.status(404).json({ message: 'Vehicle not found' });
  }

  const nextStatus = status || 'On Hold';
  if (nextStatus === 'Active' && !(await hasAllPhotoSides(vehicle._id))) {
    return res.status(400).json({
      message: 'Upload all 4 vehicle photos (front, back, passenger side, driver side) before setting status to Active',
    });
  }

  vehicle.set({ vehicleNo, vehicleType, vehicleCategory, transmission, fuel, status: nextStatus, make, model, year, ownerName, ownerMobile });
  await vehicle.save();

  res.status(200).json({
    data: { ...vehicle.toObject(), ...(await vehicleMediaSummary(vehicle._id)) },
    message: 'Vehicle updated successfully',
  });
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

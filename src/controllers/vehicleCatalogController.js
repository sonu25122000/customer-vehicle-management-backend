import { body, validationResult } from 'express-validator';
import VehicleCatalog from '../models/VehicleCatalog.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const KINDS = ['vehicleType', 'category', 'make', 'model'];

// Vehicle type/category/make/model are fully admin-managed data, added and removed only
// through the two endpoints below (and the "Vehicle Catalog" tab in the frontend) — no
// hardcoded list anywhere in this chain. See models/VehicleCatalog.js for the single-document
// shape this reads and mutates, and its isDeleted soft-delete convention.

export const catalogItemValidators = [
  body('kind').trim().notEmpty().withMessage('Kind is required').isIn(KINDS).withMessage('Invalid kind'),
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 60 }).withMessage('Name is too long'),
  // category/make are nested under a vehicleType; model is nested under a make, which is
  // itself nested under a vehicleType — so model needs both to locate the right slot.
  body('vehicleType')
    .if(body('kind').isIn(['category', 'make', 'model']))
    .trim()
    .notEmpty()
    .withMessage('Vehicle type is required'),
  body('make')
    .if(body('kind').equals('model'))
    .trim()
    .notEmpty()
    .withMessage('Make is required'),
];

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
}

async function getCatalogDoc() {
  const existing = await VehicleCatalog.findOne();
  if (existing) return existing;
  return VehicleCatalog.create({ vehicleTypes: [] });
}

// Look-ups search across *all* entries (including soft-deleted ones) so add/remove can find a
// previously-deleted entry to revive or re-delete — callers that need an "is this usable right
// now" answer additionally check `.isDeleted` themselves.
function findVehicleType(doc, name) {
  return doc.vehicleTypes.find((vt) => vt.name.toLowerCase() === name.trim().toLowerCase());
}

function findMake(vehicleTypeEntry, name) {
  return vehicleTypeEntry.makes.find((m) => m.name.toLowerCase() === name.trim().toLowerCase());
}

// Strips every isDeleted entry (at every level) out of the response — the one place that
// guarantees deleted vehicle types/categories/makes/models never reach the UI, anywhere.
function serializeCatalog(doc) {
  return {
    vehicleTypes: doc.vehicleTypes
      .filter((vt) => !vt.isDeleted)
      .map((vt) => ({
        name: vt.name,
        categories: vt.categories.filter((c) => !c.isDeleted).map((c) => c.name),
        makes: vt.makes
          .filter((m) => !m.isDeleted)
          .map((m) => ({
            name: m.name,
            models: m.models.filter((md) => !md.isDeleted).map((md) => md.name),
          })),
      })),
  };
}

// GET /api/vehicle-catalog — the whole tree, for both the admin management tab and the
// vehicle form's dropdowns.
export const listCatalog = asyncHandler(async (_req, res) => {
  const doc = await getCatalogDoc();
  res.status(200).json({ data: serializeCatalog(doc) });
});

// POST /api/vehicle-catalog — add a vehicle type / category / make / model. Adding a name that
// matches a previously soft-deleted entry revives it in place instead of creating a duplicate.
export const addCatalogItem = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { kind, vehicleType, make, name } = req.body;
  const doc = await getCatalogDoc();

  if (kind === 'vehicleType') {
    const existing = findVehicleType(doc, name);
    if (existing && !existing.isDeleted) {
      return res.status(409).json({ message: 'This vehicle type already exists' });
    }
    if (existing) existing.isDeleted = false;
    else doc.vehicleTypes.push({ name, isDeleted: false, categories: [], makes: [] });
  } else {
    const vt = findVehicleType(doc, vehicleType);
    if (!vt || vt.isDeleted) {
      return res.status(400).json({ message: 'Selected vehicle type does not exist' });
    }

    if (kind === 'category') {
      const existing = vt.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (existing && !existing.isDeleted) {
        return res.status(409).json({ message: 'This category already exists' });
      }
      if (existing) existing.isDeleted = false;
      else vt.categories.push({ name, isDeleted: false });
    } else if (kind === 'make') {
      const existing = findMake(vt, name);
      if (existing && !existing.isDeleted) {
        return res.status(409).json({ message: 'This make already exists' });
      }
      if (existing) existing.isDeleted = false;
      else vt.makes.push({ name, isDeleted: false, models: [] });
    } else {
      // kind === 'model'
      const mk = findMake(vt, make);
      if (!mk || mk.isDeleted) {
        return res.status(400).json({ message: 'Selected make does not exist under this vehicle type' });
      }
      const existing = mk.models.find((m) => m.name.toLowerCase() === name.toLowerCase());
      if (existing && !existing.isDeleted) {
        return res.status(409).json({ message: 'This model already exists' });
      }
      if (existing) existing.isDeleted = false;
      else mk.models.push({ name, isDeleted: false });
    }
  }

  await doc.save();
  res.status(201).json({ data: serializeCatalog(doc), message: 'Added successfully' });
});

// POST /api/vehicle-catalog/remove — soft-delete a vehicle type / category / make / model.
// Removing a vehicle type or make also soft-deletes everything nested under it, so nothing it
// contains stays reachable even though the parent's isDeleted flag alone would already hide it
// from serializeCatalog.
export const removeCatalogItem = asyncHandler(async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { kind, vehicleType, make, name } = req.body;
  const doc = await getCatalogDoc();

  if (kind === 'vehicleType') {
    const vt = findVehicleType(doc, name);
    if (!vt || vt.isDeleted) return res.status(404).json({ message: 'Vehicle type not found' });
    vt.isDeleted = true;
    vt.categories.forEach((c) => {
      c.isDeleted = true;
    });
    vt.makes.forEach((m) => {
      m.isDeleted = true;
      m.models.forEach((md) => {
        md.isDeleted = true;
      });
    });
  } else {
    const vt = findVehicleType(doc, vehicleType);
    if (!vt || vt.isDeleted) return res.status(404).json({ message: 'Vehicle type not found' });

    if (kind === 'category') {
      const entry = vt.categories.find((c) => c.name.toLowerCase() === name.toLowerCase() && !c.isDeleted);
      if (!entry) return res.status(404).json({ message: 'Category not found' });
      entry.isDeleted = true;
    } else if (kind === 'make') {
      const entry = findMake(vt, name);
      if (!entry || entry.isDeleted) return res.status(404).json({ message: 'Make not found' });
      entry.isDeleted = true;
      entry.models.forEach((md) => {
        md.isDeleted = true;
      });
    } else {
      // kind === 'model'
      const mk = findMake(vt, make);
      if (!mk || mk.isDeleted) return res.status(404).json({ message: 'Make not found' });
      const entry = mk.models.find((m) => m.name.toLowerCase() === name.toLowerCase() && !m.isDeleted);
      if (!entry) return res.status(404).json({ message: 'Model not found' });
      entry.isDeleted = true;
    }
  }

  await doc.save();
  res.status(200).json({ data: serializeCatalog(doc), message: 'Removed successfully' });
});

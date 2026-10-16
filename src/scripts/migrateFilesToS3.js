// One-off move of files stored the old way — base64 data URIs on the Mongo rows — into S3.
//
//   npm run migrate:s3            uploads every legacy file to S3, sets s3Key and clears the base64 data
//   npm run migrate:s3 -- --dry   only counts what would be moved
//
// Safe to run more than once: rows that already have an s3Key are skipped, and a row's base64 data is
// only cleared after its file is in S3. Needs the same MONGO_URI / S3_BUCKET / AWS_* settings as the API.
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import CustomerDocument from '../models/CustomerDocument.js';
import VehicleDocument from '../models/VehicleDocument.js';
import VehiclePhoto from '../models/VehiclePhoto.js';
import Customer from '../models/Customer.js';
import Vehicle from '../models/Vehicle.js';
import { isS3Configured, objectKey, storeFile } from '../utils/storage.js';
import {
  customerDocumentFileName,
  customerDocumentKeyParts,
  vehicleDocumentFileName,
  vehicleDocumentKeyParts,
  vehiclePhotoKeyParts,
} from '../utils/fileNames.js';

const DRY_RUN = process.argv.includes('--dry');

function decode(dataUri) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUri || '');
  if (!match) return null;
  return { mimetype: match[1], buffer: Buffer.from(match[2], 'base64'), originalname: '' };
}

// Moves every legacy row of one collection. `keyFor(row, file)` builds the S3 object key.
async function migrate(label, Model, field, keyFor) {
  const filter = { s3Key: { $exists: false }, [field]: { $exists: true, $ne: '' } };
  const total = await Model.countDocuments(filter);
  console.log(`${label}: ${total} file(s) to move`);
  if (DRY_RUN || !total) return { moved: 0, failed: 0 };

  let moved = 0;
  let failed = 0;
  // One row at a time — each can be a few MB of base64.
  const cursor = Model.find(filter).lean().cursor();
  for await (const row of cursor) {
    const file = decode(row[field]);
    if (!file) {
      console.warn(`  ${label} ${row._id}: not a data URI, skipped`);
      failed += 1;
      continue;
    }
    try {
      const key = await storeFile(file, await keyFor(row, file));
      await Model.collection.updateOne(
        { _id: row._id },
        { $set: { s3Key: key, mimeType: row.mimeType || file.mimetype, size: row.size || file.buffer.length }, $unset: { [field]: '' } }
      );
      moved += 1;
    } catch (err) {
      console.warn(`  ${label} ${row._id}: ${err.message}`);
      failed += 1;
    }
  }
  console.log(`${label}: moved ${moved}, failed ${failed}`);
  return { moved, failed };
}

async function main() {
  if (!isS3Configured()) {
    throw new Error('Set S3_BUCKET and AWS_REGION (and AWS credentials) before running this.');
  }
  await connectDB();

  const customers = new Map();
  const vehicles = new Map();
  async function customerFor(id) {
    if (!customers.has(String(id))) customers.set(String(id), (await Customer.findById(id, 'name mobile1').lean()) || {});
    return customers.get(String(id));
  }
  async function vehicleFor(id) {
    if (!vehicles.has(String(id))) vehicles.set(String(id), (await Vehicle.findById(id, 'vehicleNo make model').lean()) || {});
    return vehicles.get(String(id));
  }

  const results = [
    await migrate('Customer documents', CustomerDocument, 'file', async (row, file) => {
      const customer = await customerFor(row.customer);
      const fileName = row.fileName || customerDocumentFileName(customer, row.type, file, row.createdAt);
      return objectKey(...customerDocumentKeyParts(customer, row.type, fileName));
    }),
    await migrate('Vehicle documents', VehicleDocument, 'file', async (row, file) => {
      const vehicle = await vehicleFor(row.vehicle);
      const fileName = row.fileName || vehicleDocumentFileName(vehicle, row.type, file, row.createdAt);
      return objectKey(...vehicleDocumentKeyParts(vehicle, row.type, fileName));
    }),
    await migrate('Vehicle photos', VehiclePhoto, 'image', async (row, file) =>
      objectKey(...vehiclePhotoKeyParts(await vehicleFor(row.vehicle), row.slot, file))
    ),
  ];

  const failed = results.reduce((sum, r) => sum + r.failed, 0);
  if (failed) process.exitCode = 1;
  console.log(DRY_RUN ? 'Dry run — nothing was changed.' : 'Done.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

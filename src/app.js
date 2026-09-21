import 'dotenv/config';
import bcrypt from 'bcryptjs';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { connectDB } from './config/db.js';
import { swaggerSpec } from './config/swagger.js';
import authRoutes from './routes/authRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import tripRoutes from './routes/tripRoutes.js';
import vehicleCatalogRoutes from './routes/vehicleCatalogRoutes.js';
import couponRoutes from './routes/couponRoutes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { buildTripId } from './controllers/tripController.js';
import Admin from './models/Admin.js';
import Customer from './models/Customer.js';
import Vehicle from './models/Vehicle.js';
import Trip from './models/Trip.js';
import Coupon from './models/Coupon.js';

// Admin account is created manually (e.g. directly in the database) — not by this app.
// If ADMIN_USERNAME/ADMIN_PASSWORD are set, this syncs an *existing* admin to match them
// on startup (a way to rotate credentials without a change-password route); if they're
// unset, it does nothing and leaves the manually-created admin untouched.
async function ensureAdmin() {
  const existing = await Admin.findOne();
  if (!existing) return;

  const username = process.env.ADMIN_USERNAME?.toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;

  existing.username = username;
  existing.passwordHash = await bcrypt.hash(password, 10);
  await existing.save();
}

export const app = express();

// Render, Vercel (and most PaaS hosts) put the app behind a reverse proxy, which sets
// X-Forwarded-For. Without this, express-rate-limit throws on that header (or worse,
// trusts a client-spoofed IP) instead of resolving the real client IP.
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again later.' },
});

app.get('/api/health', (_req, res) => res.status(200).json({ status: 'ok' }));

// Auth surface documented at /api/docs — kept private (admin-only) since it maps out this
// app's entire internal API. Auth is required to even load swagger-ui's static assets from
// here, not just the JSON spec, since both are mounted behind the same guard.
app.use('/api/docs', requireAuth, requireRole('admin'), swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api/docs.json', requireAuth, requireRole('admin'), (_req, res) => res.status(200).json(swaggerSpec));

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/vehicle-catalog', vehicleCatalogRoutes);
app.use('/api/coupons', couponRoutes);

app.use(notFound);
app.use(errorHandler);

// One-time (per warm process) DB connect + admin sync + index/backfill maintenance.
// Memoized so a serverless container that handles many requests only pays this cost once;
// a failed attempt clears the memo so the next request can retry instead of staying broken
// for the container's whole lifetime.
let initPromise = null;
export function initialize() {
  if (!initPromise) {
    initPromise = (async () => {
      const requiredEnv = ['MONGO_URI', 'JWT_SECRET'];
      const missingEnv = requiredEnv.filter((key) => !process.env[key]);
      if (missingEnv.length) {
        throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
      }

      await connectDB();
      await ensureAdmin();

      // Backfills isDeleted:false on documents created before that field existed — a plain
      // { isDeleted: false } query filter does NOT match a field that's genuinely absent from
      // the stored document, so without this, pre-existing records would silently vanish from
      // every list/search/dropdown. Idempotent/self-healing across repeated restarts.
      const [customerBackfill, vehicleBackfill, tripBackfill, adminRoleBackfill] = await Promise.all([
        Customer.collection.updateMany({ isDeleted: { $exists: false } }, { $set: { isDeleted: false } }),
        Vehicle.collection.updateMany({ isDeleted: { $exists: false } }, { $set: { isDeleted: false } }),
        Trip.collection.updateMany({ isDeleted: { $exists: false } }, { $set: { isDeleted: false } }),
        // Every account that existed before roles were introduced keeps full (admin) access —
        // accounts created afterwards get whatever role the creating admin picked (see
        // authController.createUser), defaulting to viewer.
        Admin.collection.updateMany({ role: { $exists: false } }, { $set: { role: 'admin' } }),
      ]);
      if (customerBackfill.modifiedCount || vehicleBackfill.modifiedCount || tripBackfill.modifiedCount) {
        console.log(
          `Backfilled isDeleted on ${customerBackfill.modifiedCount} customer(s), ${vehicleBackfill.modifiedCount} vehicle(s), ${tripBackfill.modifiedCount} trip(s)`
        );
      }
      if (adminRoleBackfill.modifiedCount) {
        console.log(`Backfilled role:'admin' on ${adminRoleBackfill.modifiedCount} pre-existing account(s)`);
      }

      // Trip.tripId has a unique index (see models/Trip.js) — that index can't be created while
      // multiple existing trips share tripId: null, so every trip missing one gets a generated,
      // checked-unique id *before* Trip.syncIndexes() runs below.
      const legacyTrips = await Trip.find({ tripId: { $exists: false } }, '_id');
      if (legacyTrips.length) {
        const used = new Set(await Trip.distinct('tripId'));
        for (const trip of legacyTrips) {
          let candidate = buildTripId();
          while (used.has(candidate)) candidate = buildTripId();
          used.add(candidate);
          // eslint-disable-next-line no-await-in-loop
          await Trip.updateOne({ _id: trip._id }, { $set: { tripId: candidate } });
        }
        console.log(`Backfilled tripId on ${legacyTrips.length} pre-existing trip(s)`);
      }

      // Drops any indexes no longer defined on the schema and creates missing ones.
      await Promise.all([Customer.syncIndexes(), Vehicle.syncIndexes(), Trip.syncIndexes(), Coupon.syncIndexes()]);
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

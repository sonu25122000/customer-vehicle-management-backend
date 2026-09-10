import 'dotenv/config';
import bcrypt from 'bcryptjs';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { connectDB } from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import tripRoutes from './routes/tripRoutes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import Admin from './models/Admin.js';
import Customer from './models/Customer.js';
import Vehicle from './models/Vehicle.js';
import Trip from './models/Trip.js';

// Keeps the single admin account in sync with ADMIN_USERNAME/ADMIN_PASSWORD on every
// startup — there's no signup or change-password route, so editing .env and restarting
// is the only way to set/rotate admin credentials.
async function ensureAdmin() {
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const passwordHash = await bcrypt.hash(password, 10);

  const existing = await Admin.findOne();
  if (existing) {
    existing.username = username;
    existing.passwordHash = passwordHash;
    await existing.save();
  } else {
    const maxActiveSessions = Math.max(1, Number(process.env.MAX_ACTIVE_SESSIONS) || 1);
    await Admin.create({ username, passwordHash, maxActiveSessions });
    console.log(`Admin created: username="${username}"`);
  }
}

const requiredEnv = ['MONGO_URI', 'JWT_SECRET'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const app = express();

// Render (and most PaaS hosts) put the app behind a reverse proxy, which sets
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

app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/trips', tripRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

connectDB()
  .then(async () => {
    await ensureAdmin();

    // Drops any indexes no longer defined on the schema and creates missing ones.
    await Promise.all([Customer.syncIndexes(), Vehicle.syncIndexes(), Trip.syncIndexes()]);

    // Backfills isDeleted:false on documents created before that field existed — a plain
    // { isDeleted: false } query filter does NOT match a field that's genuinely absent from
    // the stored document, so without this, pre-existing records would silently vanish from
    // every list/search/dropdown. Idempotent/self-healing across repeated restarts.
    const [customerBackfill, vehicleBackfill, tripBackfill] = await Promise.all([
      Customer.collection.updateMany({ isDeleted: { $exists: false } }, { $set: { isDeleted: false } }),
      Vehicle.collection.updateMany({ isDeleted: { $exists: false } }, { $set: { isDeleted: false } }),
      Trip.collection.updateMany({ isDeleted: { $exists: false } }, { $set: { isDeleted: false } }),
    ]);
    if (customerBackfill.modifiedCount || vehicleBackfill.modifiedCount || tripBackfill.modifiedCount) {
      console.log(
        `Backfilled isDeleted on ${customerBackfill.modifiedCount} customer(s), ${vehicleBackfill.modifiedCount} vehicle(s), ${tripBackfill.modifiedCount} trip(s)`
      );
    }

    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });

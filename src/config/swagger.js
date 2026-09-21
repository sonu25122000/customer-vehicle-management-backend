import path from 'path';
import { fileURLToPath } from 'url';
import swaggerJSDoc from 'swagger-jsdoc';

// Shared request/response shapes referenced (via $ref) from the @swagger JSDoc blocks on every
// route file — defined once here so e.g. the Vehicle shape doesn't have to be retyped in
// vehicleRoutes.js, tripRoutes.js (populated vehicle) etc.
const schemas = {
  Error: {
    type: 'object',
    properties: { message: { type: 'string', example: 'Something went wrong' } },
  },
  Admin: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '652f1a2b3c4d5e6f7a8b9c0d' },
      _id: { type: 'string', description: 'Present on /auth/users responses (same value as id elsewhere)' },
      isActive: { type: 'boolean', description: 'false = deactivated (soft-deleted) — cannot log in; shown on the Users page Inactive tab' },
      deactivatedAt: { type: 'string', format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
      username: { type: 'string', example: 'jane' },
      role: { type: 'string', enum: ['viewer', 'moderator', 'admin'], example: 'viewer' },
      maxActiveSessions: { type: 'integer', example: 1 },
      activeSessionCount: { type: 'integer', example: 1 },
    },
  },
  Customer: {
    type: 'object',
    properties: {
      _id: { type: 'string' },
      name: { type: 'string', example: 'Ravi Kumar' },
      mobile1: { type: 'string', example: '9876543210' },
      mobile2: { type: 'string', example: '' },
      rating: { type: 'integer', minimum: 1, maximum: 5 },
      customerType: { type: 'string', enum: ['VIP', 'Good', 'Bad'] },
      profileVerified: { type: 'string', enum: ['Accepted', 'Rejected', 'Pending'] },
      isDeleted: { type: 'boolean' },
    },
  },
  Vehicle: {
    type: 'object',
    properties: {
      _id: { type: 'string' },
      vehicleNo: { type: 'string', example: 'KA01AB1234' },
      vehicleType: { type: 'string', example: 'Hatchback' },
      vehicleCategory: { type: 'string', example: 'Economy' },
      transmission: { type: 'string', enum: ['Manual', 'Automatic'] },
      fuel: { type: 'string', enum: ['Petrol', 'Diesel', 'CNG', 'Electric'] },
      status: { type: 'string', enum: ['Active', 'On Hold', 'Inactive'] },
      make: { type: 'string', example: 'Maruti Suzuki' },
      model: { type: 'string', example: 'Baleno' },
      year: { type: 'integer', example: 2026 },
      ownerName: { type: 'string' },
      ownerMobile: { type: 'string' },
      isDeleted: { type: 'boolean' },
    },
  },
  Trip: {
    type: 'object',
    properties: {
      _id: { type: 'string' },
      tripId: { type: 'string', example: 'RW0926AXYZ', description: 'RW + booking month + booking year + 4-char code' },
      customer: { type: 'string', description: 'Customer ObjectId (populated on read)' },
      vehicle: { type: 'string', description: 'Vehicle ObjectId (populated on read)' },
      startDate: { type: 'string', format: 'date' },
      startTime: { type: 'string', example: '09:30' },
      endDate: { type: 'string', format: 'date' },
      endTime: { type: 'string', example: '18:00' },
      amount: { type: 'number' },
      tollCharges: { type: 'number' },
      advance: { type: 'number' },
      securityDeposit: { type: 'number' },
      refundAmount: { type: 'number' },
      coupon: { type: 'string', description: 'Optional coupon ObjectId, accepted on create and — if the trip has none yet — on update. Must be applicable to the trip customer (see GET /coupons/applicable) and under its usage limit.' },
      couponCode: { type: 'string', readOnly: true, description: 'Snapshot of the applied coupon code' },
      couponDiscount: { type: 'number', readOnly: true, description: 'Rupees taken off by the coupon. amount is stored net of this.' },
      startOdometer: { type: 'number' },
      endOdometer: { type: 'number' },
      status: { type: 'string', enum: ['On Trip', 'Yet to Start', 'Completed', 'Cancelled'] },
      rating: { type: 'integer', minimum: 1, maximum: 5 },
    },
  },
  Coupon: {
    type: 'object',
    properties: {
      _id: { type: 'string' },
      code: { type: 'string', example: 'FESTIVE20' },
      discountType: { type: 'string', enum: ['percentage', 'flat'] },
      value: { type: 'number', example: 20 },
      maxDiscount: { type: 'number', minimum: 1, example: 100, description: 'Percentage coupons only — cap on the rupee discount (e.g. 20% up to ₹100). Omit for no cap; ignored for flat coupons.' },
      applicability: { type: 'string', enum: ['all', 'selected'] },
      customers: { type: 'array', items: { type: 'string' }, description: 'Customer ObjectIds; only used when applicability is "selected"' },
      startAt: { type: 'string', format: 'date-time', description: 'Must be on a 30-minute boundary (:00 or :30)' },
      expiresAt: { type: 'string', format: 'date-time', description: 'Must be on a 30-minute boundary and after startAt; a new/changed expiry must be in the future' },
      maxUsage: { type: 'integer', minimum: 1, description: 'Maximum number of times the coupon can be used. Cannot be lowered below usageCount.' },
      usageCount: { type: 'integer', readOnly: true, description: 'Times used so far — maintained by the server when a trip redeems the coupon' },
      isActive: { type: 'boolean' },
    },
  },
  Pagination: {
    type: 'object',
    properties: {
      page: { type: 'integer', example: 1 },
      limit: { type: 'integer', example: 10 },
      total: { type: 'integer', example: 42 },
      totalPages: { type: 'integer', example: 5 },
    },
  },
};

const responses = {
  ValidationError: {
    description: 'Validation failed',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  Unauthorized: {
    description: 'Not authenticated (missing/invalid/expired session cookie)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  Forbidden: {
    description: 'Authenticated, but this role is not allowed to perform this action',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  NotFound: {
    description: 'Resource not found',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  Conflict: {
    description: 'Duplicate value (e.g. vehicle number, coupon code, username already in use)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
};

const swaggerDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'Roam Wheels — Customer & Vehicle Management API',
    version: '1.0.0',
    description:
      'Internal API for the Roam Wheels admin console: customers, vehicles, trips/bookings, ' +
      'the vehicle catalog, coupons & offers, and staff account management. There is no public ' +
      'signup — every account is created by an admin via POST /auth/users. Every route except ' +
      '`/auth/login` requires the `token` session cookie set by that endpoint. Endpoints marked ' +
      '"moderator/admin" or "admin" additionally require that role — ' +
      'see the `requireRole` middleware in `src/middleware/auth.js`.\n\n' +
      '**Roles:** viewer = read-only. moderator = everything except (1) deleting anything — every ' +
      'DELETE endpoint (customers, vehicles, vehicle photos, trips, vehicle-catalog remove, coupons) ' +
      'is admin-only — and (2) the Users module (/auth/users*), which is admin-only. Moderators can ' +
      'view, create and edit coupons. admin = everything.',
  },
  servers: [{ url: (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 5000}`) + '/api' }],
  components: {
    schemas,
    responses,
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'token',
        description: 'httpOnly JWT cookie set by POST /auth/login',
      },
    },
  },
  security: [{ cookieAuth: [] }],
};

export const swaggerSpec = swaggerJSDoc({
  definition: swaggerDefinition,
  // Absolute (relative to this file, not the process cwd) so it resolves the same locally and
  // inside a serverless function whose cwd isn't the project root.
  // Forward slashes because swagger-jsdoc globs this, and glob patterns don't accept Windows backslashes.
  apis: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../routes/*.js').replace(/\\/g, '/')],
});

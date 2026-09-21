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
      applicability: { type: 'string', enum: ['all', 'selected'] },
      customers: { type: 'array', items: { type: 'string' }, description: 'Customer ObjectIds; only used when applicability is "selected"' },
      startAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' },
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
      'see the `requireRole` middleware in `src/middleware/auth.js`.',
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
  apis: ['./src/routes/*.js'],
});

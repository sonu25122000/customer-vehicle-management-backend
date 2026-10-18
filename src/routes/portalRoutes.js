import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as auth from '../controllers/portalAuthController.js';
import * as portal from '../controllers/portalController.js';
import { requireCustomer, requireCustomerSession, optionalCustomer } from '../middleware/customerAuth.js';
import { uploadCustomerDocuments, uploadProfilePhoto, handleUploadErrors } from '../middleware/upload.js';

// Customer site (the separate customer-vehicle-management-user app). Customers sign up / log in with
// their mobile number; everything except browsing cars and offers requires a customer session — and a
// customer an admin created must set their own password first (requireCustomer).
const router = Router();

// Trip OTPs are short, so wrong guesses are limited per code (utils/tripOtp.js) and per client here.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again later.' },
});

/**
 * @swagger
 * tags:
 *   - name: Customer Site
 *     description: Endpoints used by the customer-facing site (signup/login, profile, documents, cars, offers, trips)
 */

/**
 * @swagger
 * /portal/auth/signup:
 *   post:
 *     tags: [Customer Site]
 *     summary: Customer signup (mobile + password). Claims an admin-created customer with the same mobile if it has no password yet.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, mobile, password]
 *             properties:
 *               name: { type: string }
 *               mobile: { type: string, example: '9876543210' }
 *               email: { type: string }
 *               password: { type: string, minLength: 6 }
 *     responses:
 *       201: { description: Signed up and logged in (sets the customerToken cookie) }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       409: { description: An account with this mobile already exists }
 * /portal/auth/login:
 *   post:
 *     tags: [Customer Site]
 *     summary: Customer login
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mobile, password]
 *             properties:
 *               mobile: { type: string }
 *               password: { type: string }
 *     responses:
 *       200: { description: 'Logged in (sets the customerToken cookie). customer.mustChangePassword tells the site to ask for a new password first.' }
 *       401: { description: Invalid credentials }
 * /portal/auth/logout:
 *   post:
 *     tags: [Customer Site]
 *     summary: Customer logout
 *     security: []
 *     responses:
 *       200: { description: Logged out }
 * /portal/auth/me:
 *   get:
 *     tags: [Customer Site]
 *     summary: The signed-in customer (works while a password change is still required)
 *     responses:
 *       200: { description: 'Customer, including mustChangePassword' }
 *       401: { description: Not logged in }
 * /portal/auth/change-password:
 *   post:
 *     tags: [Customer Site]
 *     summary: Change password — required on the first login of a customer an admin created (or whose password an admin reset)
 *     description: >
 *       While mustChangePassword is set, every other customer endpoint answers
 *       403 { code: 'PASSWORD_CHANGE_REQUIRED' }. Changing the password clears it.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string }
 *               newPassword: { type: string, minLength: 6 }
 *     responses:
 *       200: { description: Password changed }
 *       400: { description: Wrong current password, or the new one is the same / too short }
 */
router.post('/auth/signup', authLimiter, auth.signupValidators, auth.signup);
router.post('/auth/login', authLimiter, auth.loginValidators, auth.login);
router.post('/auth/logout', auth.logout);
router.get('/auth/me', requireCustomerSession, auth.me);
router.post('/auth/change-password', authLimiter, requireCustomerSession, auth.changePasswordValidators, auth.changePassword);

/**
 * @swagger
 * /portal/vehicles:
 *   get:
 *     tags: [Customer Site]
 *     summary: Active cars — open to everyone, no login needed
 *     security: []
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: 'Matches make, model, type, category, fuel or transmission (every word must match)' }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100 } }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: 'Cars with photo ids and customer rating ({ avg, count } or null)' }
 * /portal/vehicles/{id}:
 *   get:
 *     tags: [Customer Site]
 *     summary: One car
 *     security: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Car with photo ids }
 *       404: { $ref: '#/components/responses/NotFound' }
 * /portal/vehicle-photos/{id}:
 *   get:
 *     tags: [Customer Site]
 *     summary: A car photo as an image (Active cars, or any car from the signed-in customer's own trips)
 *     security: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Image bytes }
 *       404: { description: Not found }
 * /portal/offers:
 *   get:
 *     tags: [Customer Site]
 *     summary: Live coupons marked "Show on customer site" (plus a signed-in customer's own selected-customer coupons)
 *     security: []
 *     responses:
 *       200: { description: Offers }
 * /portal/vehicles/{id}/reviews:
 *   get:
 *     tags: [Customer Site]
 *     summary: Customers' ratings and reviews of one car, newest first (first name + initial only)
 *     security: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Reviews }
 * /portal/testimonials:
 *   get:
 *     tags: [Customer Site]
 *     summary: Home page reviews carousel (managed in the admin portal's Home Carousel page)
 *     security: []
 *     responses:
 *       200: { description: Slides }
 * /portal/stats:
 *   get:
 *     tags: [Customer Site]
 *     summary: Home page headline numbers (cars, completed trips, average rating)
 *     security: []
 *     responses:
 *       200: { description: Stats }
 * /portal/subscribe:
 *   post:
 *     tags: [Customer Site]
 *     summary: Subscribe an email for offers and updates (home page "Let us know your email" form)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [email], properties: { email: { type: string, format: email } } }
 *     responses:
 *       200: { description: Subscribed (also returned if the email was already subscribed) }
 *       400: { $ref: '#/components/responses/ValidationError' }
 */
router.get('/vehicles', portal.vehicleListValidators, portal.listVehicles);
router.get('/vehicles/:id', portal.getVehicle);
router.get('/vehicles/:id/reviews', portal.listVehicleReviews);
router.get('/testimonials', portal.listTestimonials);
router.get('/stats', portal.getSiteStats);
router.get('/vehicle-photos/:id', optionalCustomer, portal.getVehiclePhotoImage);
router.get('/offers', optionalCustomer, portal.listOffers);
router.post('/subscribe', authLimiter, portal.subscribeValidators, portal.subscribe);

/**
 * @swagger
 * /portal/profile:
 *   get:
 *     tags: [Customer Site]
 *     summary: Signed-in customer's profile, each document's review status and trip counts
 *     responses:
 *       200: { description: Profile }
 *   patch:
 *     tags: [Customer Site]
 *     summary: Update name / email (the mobile number is the login and can't be changed; each change is kept in the edit history)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               email: { type: string }
 *     responses:
 *       200: { description: Updated }
 * /portal/documents:
 *   post:
 *     tags: [Customer Site]
 *     summary: Upload verification documents (aadhaar front / aadhaarBack / drivingLicence / selfie) — only the uploaded ones go back to Pending review
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               aadhaar: { type: string, format: binary, description: Aadhaar front }
 *               aadhaarBack: { type: string, format: binary, description: Aadhaar back }
 *               drivingLicence: { type: string, format: binary }
 *               selfie: { type: string, format: binary }
 *     responses:
 *       200: { description: Uploaded }
 * /portal/documents/{id}/file:
 *   get:
 *     tags: [Customer Site]
 *     summary: One of the signed-in customer's own documents (the image or PDF), to view what they uploaded
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The file }
 *       404: { description: Not found (or not this customer's) }
 * /portal/trips:
 *   get:
 *     tags: [Customer Site]
 *     summary: Signed-in customer's trips (with the car's photo ids)
 *     responses:
 *       200: { description: Trips }
 *   post:
 *     tags: [Customer Site]
 *     summary: Book a car (booking source Direct) — only when ENABLE_PORTAL_BOOKING=true, otherwise 403
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vehicle, startDate, startTime, endDate, endTime]
 *             properties:
 *               vehicle: { type: string }
 *               startDate: { type: string, format: date }
 *               startTime: { type: string, example: '10:00' }
 *               endDate: { type: string, format: date }
 *               endTime: { type: string, example: '18:00' }
 *     responses:
 *       201: { description: Booked }
 *       403: { description: Online booking is switched off }
 *       409: { description: Car already booked for those dates }
 * /portal/trips/{id}:
 *   get:
 *     tags: [Customer Site]
 *     summary: One of the signed-in customer's trips
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Trip }
 *       404: { $ref: '#/components/responses/NotFound' }
 * /portal/trips/{id}/start:
 *   post:
 *     tags: [Customer Site]
 *     summary: Start a Yet to Start trip with the 6-digit start OTP an admin shared
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [otp], properties: { otp: { type: string, example: '482913' } } }
 *     responses:
 *       200: { description: Trip is now On Trip }
 *       400: { description: Wrong / expired OTP, or the trip can't be started }
 *       403: { description: "code PROFILE_NOT_VERIFIED — the customer's documents aren't all approved yet" }
 * /portal/trips/{id}/end:
 *   post:
 *     tags: [Customer Site]
 *     summary: End an On Trip trip with the 6-digit end OTP an admin shared
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [otp], properties: { otp: { type: string } } }
 *     responses:
 *       200: { description: Trip is now Completed }
 *       400: { description: Wrong / expired OTP, or the trip isn't ongoing }
 * /portal/trips/{id}/rating:
 *   post:
 *     tags: [Customer Site]
 *     summary: Rate the car after a Completed trip (once)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *               review: { type: string, maxLength: 500 }
 *     responses:
 *       200: { description: Rated }
 *       409: { description: Already rated }
 */
router.get('/profile', requireCustomer, portal.getProfile);
router.patch('/profile', requireCustomer, portal.profileValidators, portal.updateProfile);
/**
 * @swagger
 * /portal/profile/photo:
 *   get:
 *     tags: [Customer Site]
 *     summary: The signed-in customer's profile picture (image bytes; 404 when none)
 *     responses:
 *       200: { description: Image }
 *       404: { description: No picture }
 *   post:
 *     tags: [Customer Site]
 *     summary: Upload / replace the profile picture (JPEG, PNG or WebP, max 2 MB)
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema: { type: object, properties: { photo: { type: string, format: binary } } }
 *     responses:
 *       200: { description: 'Updated customer (photoVersion set)' }
 *       400: { description: No file / wrong type / too large }
 *       503: { description: File storage (S3) isn't configured }
 *   delete:
 *     tags: [Customer Site]
 *     summary: Remove the profile picture
 *     responses:
 *       200: { description: Removed }
 */
router.get('/profile/photo', requireCustomer, portal.getProfilePhoto);
router.post('/profile/photo', requireCustomer, uploadProfilePhoto, handleUploadErrors, portal.uploadProfilePhoto);
router.delete('/profile/photo', requireCustomer, portal.removeProfilePhoto);
router.post('/documents', requireCustomer, uploadCustomerDocuments, handleUploadErrors, portal.uploadDocuments);
router.get('/documents/:id/file', requireCustomer, portal.getDocumentFile);
router.get('/trips', requireCustomer, portal.listTrips);
router.post('/trips', requireCustomer, portal.bookingValidators, portal.createBooking);
/**
 * @swagger
 * /portal/coupons/validate:
 *   post:
 *     tags: [Customer Site]
 *     summary: Check a coupon code for a booking and get its discount (the booking checks it again)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, vehicle, startDate, startTime, endDate, endTime]
 *             properties:
 *               code: { type: string }
 *               vehicle: { type: string }
 *               startDate: { type: string, format: date }
 *               startTime: { type: string }
 *               endDate: { type: string, format: date }
 *               endTime: { type: string }
 *     responses:
 *       200: { description: '{ code, amount, discount, payable, ... }' }
 *       400: { description: Invalid / expired / not for this customer / used up }
 */
router.post('/coupons/validate', authLimiter, requireCustomer, portal.couponValidators, portal.validateCoupon);
router.get('/trips/:id', requireCustomer, portal.getTrip);
router.post('/trips/:id/start', otpLimiter, requireCustomer, portal.otpValidators, portal.startTrip);
router.post('/trips/:id/end', otpLimiter, requireCustomer, portal.otpValidators, portal.endTrip);
router.post('/trips/:id/rating', requireCustomer, portal.ratingValidators, portal.rateTrip);

export default router;

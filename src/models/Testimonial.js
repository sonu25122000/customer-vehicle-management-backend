import mongoose from 'mongoose';

// One slide of the reviews carousel on the customer site's home page, managed from the admin portal's
// "Home Carousel" page. A slide is either written by an admin or picked from a customer's review of a
// trip (`trip` set — the text and rating are copied in, so editing the slide never changes the review).
// The site leads with the 5 latest customer reviews, then shows these active slides (in `order`), up to
// MAX_ACTIVE_TESTIMONIALS in all (testimonialController.publicTestimonials).
export const MAX_ACTIVE_TESTIMONIALS = 7;

const testimonialSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: [50, 'Name cannot exceed 50 characters'],
    },
    // Shown under the name, e.g. "Bengaluru" or "Weekend trip to Coorg".
    subtitle: {
      type: String,
      trim: true,
      maxlength: [60, 'Subtitle cannot exceed 60 characters'],
      default: '',
    },
    text: {
      type: String,
      required: [true, 'Review text is required'],
      trim: true,
      maxlength: [500, 'Review cannot exceed 500 characters'],
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: 5,
    },
    // The car it was about, shown as e.g. "Maruti Baleno" (copied from the trip, or typed in).
    carName: { type: String, trim: true, maxlength: 60, default: '' },
    trip: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

testimonialSchema.index({ isDeleted: 1, isActive: 1, order: 1 });

export default mongoose.model('Testimonial', testimonialSchema);

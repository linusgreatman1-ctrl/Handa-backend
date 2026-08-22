-- Home Cook bookings now collect payment immediately when the customer
-- sends the request, instead of after the vendor accepts. PAID marks that
-- intermediate "paid, awaiting vendor decision" state so it isn't confused
-- with REQUESTED (not yet paid) or CONFIRMED (vendor accepted).
ALTER TYPE "BookingStatus" ADD VALUE 'PAID';

-- AlterTable
-- Negotiated-booking flow (Event Planner, always; Home Cook Event Catering
-- Package, packageKey='premium') -- layers on top of the existing CONFIRMED
-- status without a new BookingStatus enum value, same pattern already used
-- by vendorJobStartedAt/pendingEditSnapshot. See escrow.service.js's new
-- partialReleaseHold and bookings.controller.js's negotiation/release/
-- request-payment endpoints.
ALTER TABLE "Booking" ADD COLUMN "negotiationEndedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "negotiationEndedBy" TEXT;
ALTER TABLE "Booking" ADD COLUMN "amountReleasedKobo" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "pendingPaymentRequestKobo" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "pendingPaymentRequestedAt" TIMESTAMP(3);

-- CreateIndex
-- orderFlow.confirmBookingPayment now looks this up on every single
-- booking payment (Home Cook and both EP paths) to decide whether a
-- newly-paid EVENT_PLANNING booking should auto-CONFIRM (proposal path) or
-- wait on requiredStatusForVendorDecision (direct path) -- was previously
-- unindexed since nothing queried EventProposal by bookingId on a hot path.
CREATE INDEX "EventProposal_bookingId_idx" ON "EventProposal"("bookingId");

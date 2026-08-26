-- Links an accepted EventProposal to the real Booking created for it, so
-- the planner's own "Your Proposal" view can act on that booking directly
-- (e.g. Mark Job Completed) instead of only ever seeing it via a one-time
-- notification.
ALTER TABLE "EventProposal" ADD COLUMN "bookingId" TEXT;

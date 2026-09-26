-- Booking: explicit "Search for a Rider" step, separate from Mark Ready
ALTER TABLE "Booking" ADD COLUMN "riderSearchStartedAt" TIMESTAMP(3);

-- Any cake already marked ready before this split was already being broadcast
-- to riders -- keep those visible exactly as before.
UPDATE "Booking" SET "riderSearchStartedAt" = "vendorReadyAt" WHERE "type" = 'CAKE' AND "vendorReadyAt" IS NOT NULL;

-- CakeRequest: delivery address + time collected up front
ALTER TABLE "CakeRequest" ADD COLUMN "neededByTime" TEXT;
ALTER TABLE "CakeRequest" ADD COLUMN "deliveryAddress" TEXT;

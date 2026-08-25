-- Shop-For-Me call pause/resume timing + emergency-end attribution.
ALTER TABLE "ShopSession" ADD COLUMN "callPausedAt" TIMESTAMP(3);
ALTER TABLE "ShopSession" ADD COLUMN "callPausedTotalMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShopSession" ADD COLUMN "emergencyEndedBy" TEXT;

-- Booking cancellation reason/attribution + a permanent "was ever edited" flag.
ALTER TABLE "Booking" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "Booking" ADD COLUMN "cancelledBy" TEXT;
ALTER TABLE "Booking" ADD COLUMN "wasEdited" BOOLEAN NOT NULL DEFAULT false;

-- EventRequest explicit poster name/phone.
ALTER TABLE "EventRequest" ADD COLUMN "posterName" TEXT;
ALTER TABLE "EventRequest" ADD COLUMN "posterPhone" TEXT;

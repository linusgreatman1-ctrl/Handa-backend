-- Where a posted request is: only vendors in this state (and LGA, when
-- set) see it and are notified. Both optional; null = everywhere.
ALTER TABLE "EventRequest" ADD COLUMN "state" TEXT;
ALTER TABLE "EventRequest" ADD COLUMN "lga" TEXT;
ALTER TABLE "CateringRequest" ADD COLUMN "state" TEXT;
ALTER TABLE "CateringRequest" ADD COLUMN "lga" TEXT;
ALTER TABLE "CakeRequest" ADD COLUMN "state" TEXT;
ALTER TABLE "CakeRequest" ADD COLUMN "lga" TEXT;

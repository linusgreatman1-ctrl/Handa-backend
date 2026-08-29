-- Live progress signal for "shopper confirmed handover to rider" (post
-- 3-way call), read by both the rider's and customer's own screens so the
-- text updates for real and survives a reload -- see shopSessions
-- controller's confirmHandover.
ALTER TABLE "ShopSession" ADD COLUMN "handoverConfirmedAt" TIMESTAMP(3);

-- Purely additive: two new nullable columns, no drops, no renames, no
-- data touched. Used to bill the shopper video-call session fee by real
-- duration instead of item count.

-- AlterTable
ALTER TABLE "ShopSession" ADD COLUMN "callStartedAt" TIMESTAMP(3);
ALTER TABLE "ShopSession" ADD COLUMN "callEndedAt" TIMESTAMP(3);

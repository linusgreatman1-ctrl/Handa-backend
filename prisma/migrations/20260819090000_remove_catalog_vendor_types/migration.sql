-- Remove GROCERY, CATERER, CAKE_DESIGNER vendor types and the Order/
-- OrderItem checkout model that existed solely to serve them (RAW_FOOD
-- and CAKE were the only two OrderType values; HOME_COOK/EVENT_PLANNER
-- have always used Booking instead). Order.vendorId and Booking.vendorId
-- are ON DELETE RESTRICT, so dependent rows must be cleared before the
-- vendor accounts themselves can be deleted.

-- Clear all Order rows (OrderItem cascades; Rating.orderId/EscrowHold.orderId
-- are ON DELETE SET NULL, so no separate cleanup needed for those).
DELETE FROM "Order";

-- Clear any CATERING-type bookings (Rating.bookingId/EscrowHold.bookingId are
-- ON DELETE SET NULL). Defensive — the caterer never had a real UI path to
-- receive bookings, so this is expected to be a no-op.
DELETE FROM "Booking" WHERE "type" = 'CATERING';

-- Remove the three now-obsolete demo vendor accounts entirely. Cascades
-- (all ON DELETE CASCADE from User/VendorProfile) take care of
-- VendorProfile, MenuItem, ServicePackage, CommissionPeriod, FeatureBoost,
-- EventProposal, Wallet, RefreshToken, NotificationPreference, etc.
DELETE FROM "User" WHERE "email" IN ('grocery@example.com', 'caterer@example.com', 'cakes@example.com');

-- Order/OrderItem are now fully unused — drop them entirely. The FK-bearing
-- columns that still reference "Order" must be dropped first (dropping a
-- column drops its constraint too), or Postgres refuses to drop "Order"
-- while EscrowHold_orderId_fkey/Rating_orderId_fkey still depend on it.
ALTER TABLE "Rating" DROP COLUMN "orderId";
ALTER TABLE "EscrowHold" DROP COLUMN "orderId";
DROP TABLE "OrderItem";
DROP TABLE "Order";
DROP TYPE "OrderType";
DROP TYPE "OrderStatus";

-- MenuItem.unit/.deliveryDays were grocery/cake-only fields, now dead.
ALTER TABLE "MenuItem" DROP COLUMN "unit";
ALTER TABLE "MenuItem" DROP COLUMN "deliveryDays";

-- AlterEnum: trim VendorType to HOME_COOK, EVENT_PLANNER
BEGIN;
CREATE TYPE "VendorType_new" AS ENUM ('HOME_COOK', 'EVENT_PLANNER');
ALTER TABLE "VendorProfile" ALTER COLUMN "vtype" TYPE "VendorType_new" USING ("vtype"::text::"VendorType_new");
ALTER TYPE "VendorType" RENAME TO "VendorType_old";
ALTER TYPE "VendorType_new" RENAME TO "VendorType";
DROP TYPE "VendorType_old";
COMMIT;

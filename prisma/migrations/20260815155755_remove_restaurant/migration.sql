-- AlterEnum
BEGIN;
CREATE TYPE "OrderType_new" AS ENUM ('RAW_FOOD', 'CAKE');
ALTER TABLE "Order" ALTER COLUMN "type" TYPE "OrderType_new" USING ("type"::text::"OrderType_new");
ALTER TYPE "OrderType" RENAME TO "OrderType_old";
ALTER TYPE "OrderType_new" RENAME TO "OrderType";
DROP TYPE "OrderType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "VendorType_new" AS ENUM ('GROCERY', 'CATERER', 'HOME_COOK', 'EVENT_PLANNER', 'CAKE_DESIGNER');
ALTER TABLE "VendorProfile" ALTER COLUMN "vtype" TYPE "VendorType_new" USING ("vtype"::text::"VendorType_new");
ALTER TYPE "VendorType" RENAME TO "VendorType_old";
ALTER TYPE "VendorType_new" RENAME TO "VendorType";
DROP TYPE "VendorType_old";
COMMIT;


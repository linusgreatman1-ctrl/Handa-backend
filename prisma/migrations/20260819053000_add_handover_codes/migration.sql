-- AlterTable
ALTER TABLE "Order" ADD COLUMN "pickupCode" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "deliveryCode" TEXT;

-- AlterTable
ALTER TABLE "ShopSession" ADD COLUMN "pickupCode" TEXT;

-- AlterTable
ALTER TABLE "ShopSession" ADD COLUMN "deliveryCode" TEXT;

-- Two-step emergency end: shopper requests, customer confirms/declines.
ALTER TABLE "ShopSession" ADD COLUMN "emergencyEndPendingBy" TEXT;

-- Rider arrival signals, distinct from pickup/delivery-code confirmation.
ALTER TABLE "ShopSession" ADD COLUMN "riderArrivedShopperAt" TIMESTAMP(3);
ALTER TABLE "ShopSession" ADD COLUMN "riderArrivedCustomerAt" TIMESTAMP(3);

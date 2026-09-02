-- Tracks each of the 3 real parties (customer, shopper, rider) genuinely
-- joining the 3-way confirm call, so completeConfirmCall can require all
-- three instead of letting any single party mark it done unilaterally.
ALTER TABLE "ShopSession" ADD COLUMN "confirmCallCustomerJoinedAt" TIMESTAMP(3);
ALTER TABLE "ShopSession" ADD COLUMN "confirmCallShopperJoinedAt" TIMESTAMP(3);
ALTER TABLE "ShopSession" ADD COLUMN "confirmCallRiderJoinedAt" TIMESTAMP(3);

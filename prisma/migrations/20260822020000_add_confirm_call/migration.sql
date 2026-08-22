-- Real 3-way rider+shopper+customer confirm call before delivery completion
ALTER TABLE "ShopSession" ADD COLUMN "confirmCallCompletedAt" TIMESTAMP(3);

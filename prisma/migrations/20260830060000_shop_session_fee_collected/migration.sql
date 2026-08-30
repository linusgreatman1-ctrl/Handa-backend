-- Tracks what was actually paid in for each Shop-For-Me fee component,
-- distinct from sessionFeeKobo/riderFeeKobo (which get overwritten to the
-- real computed value as it becomes known). Nullable/additive only --
-- see shopSessions.controller.js's createSession/findRider/
-- riderArrivedShopper and the new payShopSessionShortfall.
ALTER TABLE "ShopSession" ADD COLUMN "sessionFeeCollectedKobo" INTEGER;
ALTER TABLE "ShopSession" ADD COLUMN "riderFeeCollectedKobo" INTEGER;

-- New purpose for the combined session-fee + rider-fee shortfall payment,
-- paid via POST /shop-sessions/:id/pay-shortfall (Bank Transfer / Card /
-- USSD path -- WALLET is handled inline and doesn't need this).
ALTER TYPE "ManualPaymentPurpose" ADD VALUE 'SHOP_SESSION_SHORTFALL_PAYMENT';

-- MenuItem: which of the vendor's own package tiers this dish belongs to (CATERING only)
ALTER TABLE "MenuItem" ADD COLUMN "packageTier" TEXT;

-- ServicePackage: per-head price range (CATERING only; EP keeps using priceKobo as a flat fee)
ALTER TABLE "ServicePackage" ADD COLUMN "minPriceKobo" INTEGER;
ALTER TABLE "ServicePackage" ADD COLUMN "maxPriceKobo" INTEGER;

-- CateringRequest: event time + explicit meal/drinks preferences
ALTER TABLE "CateringRequest" ADD COLUMN "eventTime" TEXT;
ALTER TABLE "CateringRequest" ADD COLUMN "mealPreferences" TEXT;

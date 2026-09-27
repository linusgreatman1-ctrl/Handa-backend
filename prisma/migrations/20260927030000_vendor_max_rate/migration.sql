-- Home cooks price a cooking session as a range (e.g. N4,000 - N10,000,
-- depending on the food): hourlyRateKobo is the low end, this the high end.
ALTER TABLE "VendorProfile" ADD COLUMN "maxRateKobo" INTEGER;

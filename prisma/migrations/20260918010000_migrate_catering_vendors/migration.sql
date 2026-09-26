-- Data migration: any existing Home Cook vendor who already offers the
-- "Event Catering Package" (ServicePackage.key = 'PREMIUM') is converted to
-- the new standalone CATERING vendor type, per product decision to
-- auto-migrate rather than leave them under Home Cook. Must run in its own
-- migration, AFTER the 'CATERING' value added to VendorType in the prior
-- migration has committed -- Postgres does not allow a newly added enum
-- value to be referenced within the same transaction that added it.
UPDATE "VendorProfile"
SET vtype = 'CATERING'
WHERE vtype = 'HOME_COOK'
  AND id IN (SELECT DISTINCT "vendorId" FROM "ServicePackage" WHERE key = 'PREMIUM');

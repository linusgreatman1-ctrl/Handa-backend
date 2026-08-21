-- Purely additive: one new enum value (CUSTOM) and one new nullable
-- column on ServicePackage. No drops, no renames, no data touched.

-- AlterEnum
ALTER TYPE "PackageKey" ADD VALUE 'CUSTOM';

-- AlterTable
ALTER TABLE "ServicePackage" ADD COLUMN "guestCount" INTEGER;

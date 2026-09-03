-- AlterEnum
-- ID_DOCUMENT replaces NIN_SLIP as the real "prove your identity" slot --
-- NIN_SLIP stays in the enum (never dropped, matching this project's
-- additive-only convention) but is no longer used by new submissions.
ALTER TYPE "KycDocType" ADD VALUE 'ID_DOCUMENT';

-- CreateEnum
CREATE TYPE "KycIdType" AS ENUM ('NIN', 'DRIVERS_LICENSE', 'INTL_PASSPORT', 'VOTERS_CARD');

-- AlterTable
ALTER TABLE "KycDocument" ADD COLUMN "idType" "KycIdType",
ADD COLUMN "idNumber" TEXT;

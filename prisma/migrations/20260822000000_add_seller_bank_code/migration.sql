-- Purely additive: one new nullable column, no drops/renames.

-- AlterTable
ALTER TABLE "RegisteredSeller" ADD COLUMN "bankCode" TEXT;

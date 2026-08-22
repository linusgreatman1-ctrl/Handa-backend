-- Purely additive: one new table (BulkSms), no drops, no renames.

-- CreateTable
CREATE TABLE "BulkSms" (
    "id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recipientPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sentCount" INTEGER NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "sentById" TEXT NOT NULL,
    "sentByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BulkSms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkSms_createdAt_idx" ON "BulkSms"("createdAt");

-- Purely additive: one new table (BulkEmail), no drops, no renames.

-- CreateTable
CREATE TABLE "BulkEmail" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recipientEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sentCount" INTEGER NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "sentById" TEXT NOT NULL,
    "sentByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BulkEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkEmail_createdAt_idx" ON "BulkEmail"("createdAt");

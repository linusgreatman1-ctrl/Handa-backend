-- Money seen arriving in the company account, matched to waiting bank-transfer requests by the system.
CREATE TABLE "BankCredit" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "narration" TEXT,
    "payerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "matchedRef" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankCredit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BankCredit_providerRef_key" ON "BankCredit"("providerRef");
CREATE INDEX "BankCredit_status_createdAt_idx" ON "BankCredit"("status", "createdAt");

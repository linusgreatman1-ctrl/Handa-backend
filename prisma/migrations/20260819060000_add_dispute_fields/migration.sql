-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "isDispute" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "evidenceUrl" TEXT;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "requestedRefundKobo" INTEGER;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "refundAmountKobo" INTEGER;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "refundedAt" TIMESTAMP(3);

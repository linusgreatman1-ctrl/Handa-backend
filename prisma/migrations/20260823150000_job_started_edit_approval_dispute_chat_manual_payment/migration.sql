-- Home Cook's new two-stage "Job Started -> Mark Job Complete" vendor flow,
-- plus a shared (Cook + Event Planner) edit-approval mechanism: a
-- customer's edit while the job hasn't started/passed no longer applies
-- immediately -- it's held here awaiting the vendor's Accept/Decline.
ALTER TABLE "Booking" ADD COLUMN "vendorJobStartedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "pendingEditSnapshot" JSONB;
ALTER TABLE "Booking" ADD COLUMN "pendingEditRequestedAt" TIMESTAMP(3);

-- Per-ticket (not per-user) admin dispute chat, with a close mechanism.
ALTER TYPE "ChatContextType" ADD VALUE 'DISPUTE';
ALTER TABLE "ChatThread" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "ChatThread" ADD COLUMN "closedBy" TEXT;

-- Manual bank-transfer payment queue (replaces Paystack for that one
-- payment method, app-wide) -- see ManualPaymentRequest in schema.prisma.
CREATE TYPE "ManualPaymentPurpose" AS ENUM ('WALLET_DEPOSIT', 'BOOKING_PAYMENT', 'SHOP_SESSION_PAYMENT', 'SHOP_SESSION_CALL_TOPUP', 'SHOP_SESSION_RIDER_FEE_TOPUP', 'COMMISSION_PAYMENT', 'FEATURE_BOOST_PAYMENT');
CREATE TYPE "ManualPaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

CREATE TABLE "ManualPaymentRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "ManualPaymentPurpose" NOT NULL,
    "targetId" TEXT,
    "amountKobo" INTEGER NOT NULL,
    "status" "ManualPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedByAdminId" TEXT,

    CONSTRAINT "ManualPaymentRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManualPaymentRequest_reference_key" ON "ManualPaymentRequest"("reference");
CREATE INDEX "ManualPaymentRequest_userId_idx" ON "ManualPaymentRequest"("userId");
CREATE INDEX "ManualPaymentRequest_status_idx" ON "ManualPaymentRequest"("status");

ALTER TABLE "ManualPaymentRequest" ADD CONSTRAINT "ManualPaymentRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

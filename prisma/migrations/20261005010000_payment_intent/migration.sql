-- Every card/USSD checkout started with a payment gateway (Paystack or
-- Flutterwave): which gateway, what it is for (metadata), how much is due,
-- and when it was applied -- so a confirmed payment is routed by what the
-- server recorded, checked against the amount due, verified with the same
-- gateway it was paid on, and applied exactly once.
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "gateway" TEXT NOT NULL DEFAULT 'paystack',
    "amountKobo" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "email" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentIntent_reference_key" ON "PaymentIntent"("reference");

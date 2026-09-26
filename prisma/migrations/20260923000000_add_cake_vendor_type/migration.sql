-- AlterEnum
ALTER TYPE "VendorType" ADD VALUE 'CAKE';

-- AlterEnum
ALTER TYPE "BookingType" ADD VALUE 'CAKE';

-- AlterTable: MenuItem gets a free-text lead-time note (Cakes' "not readily
-- available, ready in N days" notice, shown before the customer orders)
ALTER TABLE "MenuItem" ADD COLUMN "leadTimeNote" TEXT;

-- AlterTable: Booking gains an optional rider-delivery leg. Every column
-- here is nullable and only ever populated for CAKE bookings -- Home Cook/
-- Event Planner/Catering bookings never touch them.
ALTER TABLE "Booking" ADD COLUMN "vendorReadyAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "riderId" TEXT;
ALTER TABLE "Booking" ADD COLUMN "riderFeeKobo" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "pickupCode" TEXT;
ALTER TABLE "Booking" ADD COLUMN "deliveryCode" TEXT;
ALTER TABLE "Booking" ADD COLUMN "riderAcceptedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "riderArrivedVendorAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "vendorHandoverConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "riderArrivedCustomerAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "deliveredAt" TIMESTAMP(3);

CREATE INDEX "Booking_riderId_idx" ON "Booking"("riderId");

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "RiderProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "CakeRequestStatus" AS ENUM ('OPEN', 'PROPOSAL_ACCEPTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CakeProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "CakeRequest" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "posterName" TEXT,
    "posterPhone" TEXT,
    "occasion" TEXT NOT NULL,
    "neededByDate" TIMESTAMP(3) NOT NULL,
    "servings" INTEGER,
    "flavourPreference" TEXT,
    "budgetKobo" INTEGER,
    "notes" TEXT,
    "referencePhotoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "CakeRequestStatus" NOT NULL DEFAULT 'OPEN',
    "acceptedProposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "CakeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CakeProposal" (
    "id" TEXT NOT NULL,
    "cakeRequestId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "priceKobo" INTEGER NOT NULL,
    "timeline" TEXT,
    "notes" TEXT,
    "status" "CakeProposalStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bookingId" TEXT,

    CONSTRAINT "CakeProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CakeRequest_customerId_idx" ON "CakeRequest"("customerId");
CREATE INDEX "CakeRequest_status_idx" ON "CakeRequest"("status");
CREATE INDEX "CakeProposal_cakeRequestId_idx" ON "CakeProposal"("cakeRequestId");
CREATE INDEX "CakeProposal_vendorId_idx" ON "CakeProposal"("vendorId");
CREATE INDEX "CakeProposal_bookingId_idx" ON "CakeProposal"("bookingId");

ALTER TABLE "CakeRequest" ADD CONSTRAINT "CakeRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CakeProposal" ADD CONSTRAINT "CakeProposal_cakeRequestId_fkey" FOREIGN KEY ("cakeRequestId") REFERENCES "CakeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CakeProposal" ADD CONSTRAINT "CakeProposal_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "VendorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

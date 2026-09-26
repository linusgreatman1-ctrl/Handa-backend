-- CreateEnum
CREATE TYPE "CateringRequestStatus" AS ENUM ('OPEN', 'PROPOSAL_ACCEPTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CateringProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- AlterEnum
ALTER TYPE "VendorType" ADD VALUE 'CATERING';

-- AlterEnum
ALTER TYPE "BookingType" ADD VALUE 'CATERING';

-- CreateTable
CREATE TABLE "CateringRequest" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "posterName" TEXT,
    "posterPhone" TEXT,
    "eventType" TEXT NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "venue" TEXT NOT NULL,
    "guestCount" INTEGER,
    "budgetKobo" INTEGER,
    "servicesRequested" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "timeframe" TEXT,
    "status" "CateringRequestStatus" NOT NULL DEFAULT 'OPEN',
    "acceptedProposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "CateringRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CateringProposal" (
    "id" TEXT NOT NULL,
    "cateringRequestId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "priceKobo" INTEGER NOT NULL,
    "servicesIncluded" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeline" TEXT,
    "notes" TEXT,
    "status" "CateringProposalStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bookingId" TEXT,

    CONSTRAINT "CateringProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CateringRequest_customerId_idx" ON "CateringRequest"("customerId");

-- CreateIndex
CREATE INDEX "CateringRequest_status_idx" ON "CateringRequest"("status");

-- CreateIndex
CREATE INDEX "CateringProposal_cateringRequestId_idx" ON "CateringProposal"("cateringRequestId");

-- CreateIndex
CREATE INDEX "CateringProposal_vendorId_idx" ON "CateringProposal"("vendorId");

-- CreateIndex
CREATE INDEX "CateringProposal_bookingId_idx" ON "CateringProposal"("bookingId");

-- AddForeignKey
ALTER TABLE "CateringRequest" ADD CONSTRAINT "CateringRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CateringProposal" ADD CONSTRAINT "CateringProposal_cateringRequestId_fkey" FOREIGN KEY ("cateringRequestId") REFERENCES "CateringRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CateringProposal" ADD CONSTRAINT "CateringProposal_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "VendorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

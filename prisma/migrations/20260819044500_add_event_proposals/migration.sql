-- CreateEnum
CREATE TYPE "EventRequestStatus" AS ENUM ('OPEN', 'PROPOSAL_ACCEPTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EventProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "EventRequest" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "venue" TEXT NOT NULL,
    "guestCount" INTEGER,
    "budgetKobo" INTEGER,
    "servicesRequested" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "status" "EventRequestStatus" NOT NULL DEFAULT 'OPEN',
    "acceptedProposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "EventRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventProposal" (
    "id" TEXT NOT NULL,
    "eventRequestId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "priceKobo" INTEGER NOT NULL,
    "servicesIncluded" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeline" TEXT,
    "notes" TEXT,
    "status" "EventProposalStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventRequest_customerId_idx" ON "EventRequest"("customerId");

-- CreateIndex
CREATE INDEX "EventRequest_status_idx" ON "EventRequest"("status");

-- CreateIndex
CREATE INDEX "EventProposal_eventRequestId_idx" ON "EventProposal"("eventRequestId");

-- CreateIndex
CREATE INDEX "EventProposal_vendorId_idx" ON "EventProposal"("vendorId");

-- AddForeignKey
ALTER TABLE "EventRequest" ADD CONSTRAINT "EventRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_eventRequestId_fkey" FOREIGN KEY ("eventRequestId") REFERENCES "EventRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "VendorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

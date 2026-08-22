-- Purely additive: one new enum value, four new nullable columns, no
-- drops/renames.

-- AlterEnum
ALTER TYPE "TicketContext" ADD VALUE 'BOOKING';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "vendorConfirmedCompleteAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "customerConfirmedCompleteAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "secondPartyResponse" TEXT;
ALTER TABLE "SupportTicket" ADD COLUMN "secondPartyRespondedAt" TIMESTAMP(3);

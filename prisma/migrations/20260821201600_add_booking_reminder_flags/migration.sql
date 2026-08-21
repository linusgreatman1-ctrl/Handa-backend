-- Purely additive: two new nullable timestamp columns on Booking, used to
-- mark when the 24h/2h upcoming-booking reminders were sent. No drops, no
-- renames, no data touched.

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "reminder24SentAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "reminder2SentAt" TIMESTAMP(3);

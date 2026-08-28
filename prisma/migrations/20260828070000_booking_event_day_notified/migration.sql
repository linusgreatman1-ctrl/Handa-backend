-- Dedup flag for the new "today is your event" sweep notification sent
-- to Event Planners the day their booking is scheduled -- without it the
-- 5-minute sweep would re-notify every tick for the whole day.
ALTER TABLE "Booking" ADD COLUMN "eventDayNotifiedAt" TIMESTAMP(3);

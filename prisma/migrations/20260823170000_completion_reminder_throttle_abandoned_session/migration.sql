-- Throttles the previously-unbounded 5-minute completion-reminder sweep
-- (bookingReminders.service.js's sendCompletionReminders) to at most once
-- per COMPLETION_REMINDER_INTERVAL_MS instead of every sweep tick.
ALTER TABLE "Booking" ADD COLUMN "lastCompletionReminderAt" TIMESTAMP(3);

-- Marks a ShopSession cancelled by the stale-live-session sweep (stuck too
-- long in MATCHED/BUILDING_LIST/LIVE_CALL) so History can show a plain
-- "Uncompleted Session" instead of a normal cancelled-with-details display.
ALTER TABLE "ShopSession" ADD COLUMN "abandonedAt" TIMESTAMP(3);

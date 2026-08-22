-- Admin Live Chat + AI chatbox: marks when a human admin has taken over a
-- SUPPORT chat thread, so the AI auto-reply stops.
ALTER TABLE "ChatThread" ADD COLUMN "handledByAdminId" TEXT;

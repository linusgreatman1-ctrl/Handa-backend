-- Tracks each party explicitly choosing "Return to Homepage" on the
-- ongoing-session prompt (cleared again if they come back in). Once every
-- party currently relevant to the session is simultaneously away, the
-- session auto-cancels and refunds -- see shopSessions.controller.js's
-- markAway.
ALTER TABLE "ShopSession" ADD COLUMN "customerAwayAt" TIMESTAMP(3);
ALTER TABLE "ShopSession" ADD COLUMN "shopperAwayAt" TIMESTAMP(3);
ALTER TABLE "ShopSession" ADD COLUMN "riderAwayAt" TIMESTAMP(3);

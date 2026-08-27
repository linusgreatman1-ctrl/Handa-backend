-- Customer-side equivalent of a proposal's own "Timeline" field -- when
-- they need the event sorted by, so a planner can judge fit before ever
-- writing a proposal.
ALTER TABLE "EventRequest" ADD COLUMN "timeframe" TEXT;

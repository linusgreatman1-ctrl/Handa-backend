-- AlterTable
-- Majority-vote "away"/"continue" mechanic for the login/refresh
-- ongoing-session prompt (public/app/index.html's promptOrEnterActiveShopSession):
-- once all three roles (customer/shopper/rider) are genuinely part of a
-- session, 2 of them choosing "Return Home" cancels it outright even if
-- the third wants to continue -- but if 2 have already explicitly chosen
-- "Continue Session" from that same prompt, the third's own "Return Home"
-- is rejected instead of silently registering, since it could never
-- override their majority anyway. These *Continued fields track that
-- explicit choice distinctly from the mere ABSENCE of an *AwayAt
-- timestamp, which just means "hasn't decided yet." See
-- shopSessions.controller.js's markAway for the vote-counting logic.
ALTER TABLE "ShopSession" ADD COLUMN "customerContinuedAt" TIMESTAMP(3);
ALTER TABLE "ShopSession" ADD COLUMN "shopperContinuedAt" TIMESTAMP(3);
ALTER TABLE "ShopSession" ADD COLUMN "riderContinuedAt" TIMESTAMP(3);

-- Persists a shopper declining a broadcast-available Shop-For-Me session,
-- per shopper (the session stays visible to every OTHER online shopper).
-- Previously this was tracked only in a client-side JS Set, which reset on
-- every page refresh -- the same declined session kept reappearing for the
-- exact shopper who'd already said no.
CREATE TABLE "ShopSessionDecline" (
    "id" TEXT NOT NULL,
    "shopSessionId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopSessionDecline_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopSessionDecline_shopSessionId_shopperId_key" ON "ShopSessionDecline"("shopSessionId", "shopperId");

CREATE INDEX "ShopSessionDecline_shopperId_idx" ON "ShopSessionDecline"("shopperId");

ALTER TABLE "ShopSessionDecline" ADD CONSTRAINT "ShopSessionDecline_shopSessionId_fkey" FOREIGN KEY ("shopSessionId") REFERENCES "ShopSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShopSessionDecline" ADD CONSTRAINT "ShopSessionDecline_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "ShopperProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

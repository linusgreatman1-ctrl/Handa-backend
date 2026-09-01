-- Stores the free-text market/store name the customer types at deposit
-- time -- previously validated client-side but never sent to or persisted
-- by the backend. Used as the route origin for the real Google-Routes
-- predicted rider fee (see googleRoutes.service.js).
ALTER TABLE "ShopSession" ADD COLUMN "market" TEXT;

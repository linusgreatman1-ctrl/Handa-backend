-- WhatsApp number (used by the WhatsApp call/chat option), and a short bio
-- for riders and shoppers like vendors already have.
ALTER TABLE "User" ADD COLUMN "whatsapp" TEXT;
ALTER TABLE "RiderProfile" ADD COLUMN "bio" TEXT;
ALTER TABLE "ShopperProfile" ADD COLUMN "bio" TEXT;

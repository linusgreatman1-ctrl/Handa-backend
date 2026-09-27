-- Price negotiation on request proposals: the customer's pending counter
-- offer, and the back-and-forth history shown to both sides.
ALTER TABLE "EventProposal" ADD COLUMN "customerOfferKobo" INTEGER;
ALTER TABLE "EventProposal" ADD COLUMN "negotiation" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "CateringProposal" ADD COLUMN "customerOfferKobo" INTEGER;
ALTER TABLE "CateringProposal" ADD COLUMN "negotiation" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "CakeProposal" ADD COLUMN "customerOfferKobo" INTEGER;
ALTER TABLE "CakeProposal" ADD COLUMN "negotiation" JSONB NOT NULL DEFAULT '[]';

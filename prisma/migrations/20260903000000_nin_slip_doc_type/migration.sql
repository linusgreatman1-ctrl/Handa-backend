-- AlterEnum
-- Adds NIN Slip as a real, distinct KYC document type -- collected at
-- registration for Rider/Shopper/Home Cook/Event Planner, reviewed through
-- the same pending/approve/reject flow already built for every other doc
-- type (GOVERNMENT_ID/PROOF_OF_ADDRESS/VEHICLE_DOCUMENT).
ALTER TYPE "KycDocType" ADD VALUE 'NIN_SLIP';

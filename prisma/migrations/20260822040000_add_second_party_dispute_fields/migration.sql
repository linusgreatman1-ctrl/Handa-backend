-- Records who submitted the counter-disputing response and lets them
-- attach their own evidence, matching what the original filer already had.
ALTER TABLE "SupportTicket" ADD COLUMN "secondPartyUserId" TEXT;
ALTER TABLE "SupportTicket" ADD COLUMN "secondPartyEvidenceUrl" TEXT;

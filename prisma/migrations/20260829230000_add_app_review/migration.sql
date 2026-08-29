-- A review of the Handa app/platform itself, distinct from the existing
-- peer-to-peer Rating table. One evolving review per user, with an admin
-- response thread.
CREATE TABLE "AppReview" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "response" TEXT,
    "respondedAt" TIMESTAMP(3),
    "respondedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppReview_userId_key" ON "AppReview"("userId");

CREATE INDEX "AppReview_hidden_idx" ON "AppReview"("hidden");

ALTER TABLE "AppReview" ADD CONSTRAINT "AppReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppReview" ADD CONSTRAINT "AppReview_respondedByAdminId_fkey" FOREIGN KEY ("respondedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

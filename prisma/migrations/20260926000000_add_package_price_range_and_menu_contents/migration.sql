-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "contents" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "packageId" TEXT;

-- AlterTable
ALTER TABLE "ServicePackage" ADD COLUMN     "priceMaxKobo" INTEGER,
ADD COLUMN     "priceMinKobo" INTEGER;

-- CreateIndex
CREATE INDEX "MenuItem_packageId_idx" ON "MenuItem"("packageId");

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ServicePackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

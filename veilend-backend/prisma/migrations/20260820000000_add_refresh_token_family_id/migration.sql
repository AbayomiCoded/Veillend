-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN "familyId" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

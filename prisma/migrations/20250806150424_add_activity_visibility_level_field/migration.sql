-- AlterTable
ALTER TABLE "activity" ADD COLUMN     "performingUserRole" TEXT,
ADD COLUMN     "visibilityLevel" TEXT;

-- CreateIndex
CREATE INDEX "activity_visibilityLevel_idx" ON "activity"("visibilityLevel");

-- DropForeignKey
ALTER TABLE "activity" DROP CONSTRAINT "activity_businessId_fkey";

-- DropForeignKey
ALTER TABLE "activity" DROP CONSTRAINT "activity_performedBy_fkey";

-- AlterTable
ALTER TABLE "activity" ADD COLUMN     "tenantName" TEXT,
ALTER COLUMN "performedBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "branch" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "business" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_performedBy_fkey" FOREIGN KEY ("performedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

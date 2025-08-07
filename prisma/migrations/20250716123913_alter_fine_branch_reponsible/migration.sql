-- DropForeignKey
ALTER TABLE "fine" DROP CONSTRAINT "fine_branchId_fkey";

-- AddForeignKey
ALTER TABLE "fine" ADD CONSTRAINT "fine_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "activity" DROP CONSTRAINT "activity_performedBy_fkey";

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_performedBy_fkey" FOREIGN KEY ("performedBy") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

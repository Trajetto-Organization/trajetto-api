/*
  Warnings:

  - A unique constraint covering the columns `[driverId]` on the table `user` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "user" ADD COLUMN     "driverId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "user_driverId_key" ON "user"("driverId");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

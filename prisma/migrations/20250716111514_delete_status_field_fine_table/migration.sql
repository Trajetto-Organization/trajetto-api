/*
  Warnings:

  - You are about to drop the column `status` on the `fine` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "fine_status_idx";

-- AlterTable
ALTER TABLE "fine" DROP COLUMN "status";

-- DropEnum
DROP TYPE "FineStatus";

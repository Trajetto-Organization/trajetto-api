/*
  Warnings:

  - You are about to drop the column `fine_number` on the `fine` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "fine_fine_number_key";

-- AlterTable
ALTER TABLE "fine" DROP COLUMN "fine_number";

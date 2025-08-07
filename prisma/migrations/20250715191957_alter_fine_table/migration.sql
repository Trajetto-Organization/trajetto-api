/*
  Warnings:

  - Made the column `fine_number` on table `fine` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "fine" ALTER COLUMN "fine_number" SET NOT NULL;

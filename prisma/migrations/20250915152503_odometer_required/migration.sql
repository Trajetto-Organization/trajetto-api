/*
  Warnings:

  - Made the column `odometer_photo` on table `fuel` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "fuel" ALTER COLUMN "odometer_photo" SET NOT NULL;

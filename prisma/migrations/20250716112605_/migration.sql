/*
  Warnings:

  - You are about to drop the column `registeredById` on the `fine` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "fine" DROP CONSTRAINT "fine_registeredById_fkey";

-- AlterTable
ALTER TABLE "fine" DROP COLUMN "registeredById";

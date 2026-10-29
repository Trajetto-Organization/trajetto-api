-- Registration completeness batch (plan §7): bill category, service order
-- description and contracted fleet size. All columns are nullable/defaulted —
-- legacy rows predate the fields and stay valid.

-- CreateEnum
CREATE TYPE "AccountPayableCategory" AS ENUM ('FUEL', 'MAINTENANCE', 'INSURANCE', 'TAXES_FEES', 'FINES', 'TOLLS', 'RENTAL', 'PAYROLL', 'OTHER');

-- AlterTable
ALTER TABLE "account_payable" ADD COLUMN "category" "AccountPayableCategory";
ALTER TABLE "account_payable" ADD COLUMN "category_description" TEXT;

-- AlterTable
ALTER TABLE "service_order" ADD COLUMN "description" TEXT;

-- AlterTable
ALTER TABLE "business" ADD COLUMN "vehicle_limit" INTEGER NOT NULL DEFAULT 0;

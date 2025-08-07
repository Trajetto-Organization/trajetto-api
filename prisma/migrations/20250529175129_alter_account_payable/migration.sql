-- DropForeignKey
ALTER TABLE "account_payable" DROP CONSTRAINT "account_payable_branchId_fkey";

-- DropForeignKey
ALTER TABLE "account_payable" DROP CONSTRAINT "account_payable_registrationUserId_fkey";

-- AddForeignKey
ALTER TABLE "account_payable" ADD CONSTRAINT "account_payable_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_payable" ADD CONSTRAINT "account_payable_registrationUserId_fkey" FOREIGN KEY ("registrationUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

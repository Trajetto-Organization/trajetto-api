-- DropForeignKey
ALTER TABLE "account_payable" DROP CONSTRAINT "account_payable_registrationUserId_fkey";

-- AddForeignKey
ALTER TABLE "account_payable" ADD CONSTRAINT "account_payable_registrationUserId_fkey" FOREIGN KEY ("registrationUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

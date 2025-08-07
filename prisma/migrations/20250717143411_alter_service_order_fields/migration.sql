-- DropForeignKey
ALTER TABLE "service_order" DROP CONSTRAINT "service_order_responsibleUserId_fkey";

-- DropForeignKey
ALTER TABLE "service_order" DROP CONSTRAINT "service_order_supplierId_fkey";

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

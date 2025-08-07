-- AlterTable
ALTER TABLE "user" ADD COLUMN     "whatsapp_instance_connected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whatsapp_notifications_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whatsapp_phone" TEXT;

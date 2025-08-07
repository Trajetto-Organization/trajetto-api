-- AlterTable
ALTER TABLE "user" ADD COLUMN     "activity_notifications_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "email_notifications_enabled" BOOLEAN NOT NULL DEFAULT true;

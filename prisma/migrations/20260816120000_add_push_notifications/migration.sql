-- Push notifications: device tokens + the PUSH delivery channel. A PUSH
-- delivery row is only fanned out for recipients that actually have a
-- registered device, so the (event, user, channel) idempotency the pipeline
-- already guarantees applies to pushes too.

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'PUSH';

-- CreateTable
CREATE TABLE "push_device_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_device_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_device_token_token_key" ON "push_device_token"("token");

-- CreateIndex
CREATE INDEX "push_device_token_userId_idx" ON "push_device_token"("userId");

-- AddForeignKey
ALTER TABLE "push_device_token" ADD CONSTRAINT "push_device_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

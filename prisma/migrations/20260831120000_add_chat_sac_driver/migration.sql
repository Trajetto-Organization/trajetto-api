-- CreateEnum
CREATE TYPE "ChatMessageKind" AS ENUM ('TEXT', 'IMAGE', 'AUDIO');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "last_seen_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "chat_thread" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_message" (
    "id" TEXT NOT NULL,
    "kind" "ChatMessageKind" NOT NULL,
    "body" TEXT,
    "attachment_key" TEXT,
    "duration_ms" INTEGER,
    "deliveryId" TEXT,
    "broadcast_id" TEXT,
    "client_submission_id" TEXT,
    "threadId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_thread_read" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "last_read_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_thread_read_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_thread_businessId_last_message_at_idx" ON "chat_thread"("businessId", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_thread_businessId_driverId_key" ON "chat_thread"("businessId", "driverId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_message_client_submission_id_key" ON "chat_message"("client_submission_id");

-- CreateIndex
CREATE INDEX "chat_message_threadId_created_at_idx" ON "chat_message"("threadId", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_thread_read_threadId_userId_key" ON "chat_thread_read"("threadId", "userId");

-- AddForeignKey
ALTER TABLE "chat_thread" ADD CONSTRAINT "chat_thread_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_thread" ADD CONSTRAINT "chat_thread_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "delivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "chat_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_thread_read" ADD CONSTRAINT "chat_thread_read_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "chat_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_thread_read" ADD CONSTRAINT "chat_thread_read_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

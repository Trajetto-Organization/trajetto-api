-- CreateTable
CREATE TABLE "pending_deletion" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_deletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_deletion_userId_idx" ON "pending_deletion"("userId");

-- CreateIndex
CREATE INDEX "pending_deletion_expires_idx" ON "pending_deletion"("expires");

-- CreateIndex
CREATE UNIQUE INDEX "pending_deletion_entity_type_entity_id_userId_key" ON "pending_deletion"("entity_type", "entity_id", "userId");

-- AddForeignKey
ALTER TABLE "pending_deletion" ADD CONSTRAINT "pending_deletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

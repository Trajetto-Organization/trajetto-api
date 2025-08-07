-- CreateTable
CREATE TABLE "kanban_column" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_column_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_card" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "position" INTEGER NOT NULL,
    "columnId" TEXT NOT NULL,
    "assignedUserId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_card_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kanban_column_businessId_idx" ON "kanban_column"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_column_businessId_position_key" ON "kanban_column"("businessId", "position");

-- CreateIndex
CREATE INDEX "kanban_card_columnId_idx" ON "kanban_card"("columnId");

-- CreateIndex
CREATE INDEX "kanban_card_assignedUserId_idx" ON "kanban_card"("assignedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_card_columnId_position_key" ON "kanban_card"("columnId", "position");

-- AddForeignKey
ALTER TABLE "kanban_column" ADD CONSTRAINT "kanban_column_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "kanban_column"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "kanban_board" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_board_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_column" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#e2e8f0',
    "boardId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_column_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_card" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "dueDate" TIMESTAMP(3),
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "columnId" TEXT NOT NULL,
    "assignedToId" TEXT,
    "createdById" TEXT NOT NULL,
    "serviceOrderId" TEXT,
    "accountPayableId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_label" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_attachment" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kanban_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_comment" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_activity" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kanban_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_KanbanCardToKanbanLabel" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_KanbanCardToKanbanLabel_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "kanban_board_businessId_idx" ON "kanban_board"("businessId");

-- CreateIndex
CREATE INDEX "kanban_column_boardId_idx" ON "kanban_column"("boardId");

-- CreateIndex
CREATE INDEX "kanban_card_columnId_idx" ON "kanban_card"("columnId");

-- CreateIndex
CREATE INDEX "kanban_card_assignedToId_idx" ON "kanban_card"("assignedToId");

-- CreateIndex
CREATE INDEX "kanban_card_createdById_idx" ON "kanban_card"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_label_name_businessId_key" ON "kanban_label"("name", "businessId");

-- CreateIndex
CREATE INDEX "_KanbanCardToKanbanLabel_B_index" ON "_KanbanCardToKanbanLabel"("B");

-- AddForeignKey
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_column" ADD CONSTRAINT "kanban_column_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "kanban_board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "kanban_column"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_accountPayableId_fkey" FOREIGN KEY ("accountPayableId") REFERENCES "account_payable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_label" ADD CONSTRAINT "kanban_label_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_attachment" ADD CONSTRAINT "kanban_attachment_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "kanban_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_attachment" ADD CONSTRAINT "kanban_attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_comment" ADD CONSTRAINT "kanban_comment_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "kanban_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_comment" ADD CONSTRAINT "kanban_comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_activity" ADD CONSTRAINT "kanban_activity_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "kanban_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_activity" ADD CONSTRAINT "kanban_activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_KanbanCardToKanbanLabel" ADD CONSTRAINT "_KanbanCardToKanbanLabel_A_fkey" FOREIGN KEY ("A") REFERENCES "kanban_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_KanbanCardToKanbanLabel" ADD CONSTRAINT "_KanbanCardToKanbanLabel_B_fkey" FOREIGN KEY ("B") REFERENCES "kanban_label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

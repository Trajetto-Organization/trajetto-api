-- DropIndex
DROP INDEX "kanban_card_columnId_position_key";

-- DropIndex
DROP INDEX "kanban_column_businessId_position_key";

-- CreateIndex
CREATE INDEX "kanban_card_columnId_position_idx" ON "kanban_card"("columnId", "position");

-- CreateIndex
CREATE INDEX "kanban_column_businessId_position_idx" ON "kanban_column"("businessId", "position");

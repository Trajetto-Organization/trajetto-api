/*
  Warnings:

  - You are about to drop the `_KanbanCardToKanbanLabel` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `kanban_activity` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `kanban_attachment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `kanban_board` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `kanban_card` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `kanban_column` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `kanban_comment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `kanban_label` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "_KanbanCardToKanbanLabel" DROP CONSTRAINT "_KanbanCardToKanbanLabel_A_fkey";

-- DropForeignKey
ALTER TABLE "_KanbanCardToKanbanLabel" DROP CONSTRAINT "_KanbanCardToKanbanLabel_B_fkey";

-- DropForeignKey
ALTER TABLE "kanban_activity" DROP CONSTRAINT "kanban_activity_cardId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_activity" DROP CONSTRAINT "kanban_activity_userId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_attachment" DROP CONSTRAINT "kanban_attachment_cardId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_attachment" DROP CONSTRAINT "kanban_attachment_uploadedById_fkey";

-- DropForeignKey
ALTER TABLE "kanban_board" DROP CONSTRAINT "kanban_board_businessId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_card" DROP CONSTRAINT "kanban_card_accountPayableId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_card" DROP CONSTRAINT "kanban_card_assignedToId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_card" DROP CONSTRAINT "kanban_card_columnId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_card" DROP CONSTRAINT "kanban_card_createdById_fkey";

-- DropForeignKey
ALTER TABLE "kanban_card" DROP CONSTRAINT "kanban_card_serviceOrderId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_column" DROP CONSTRAINT "kanban_column_boardId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_comment" DROP CONSTRAINT "kanban_comment_authorId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_comment" DROP CONSTRAINT "kanban_comment_cardId_fkey";

-- DropForeignKey
ALTER TABLE "kanban_label" DROP CONSTRAINT "kanban_label_businessId_fkey";

-- DropTable
DROP TABLE "_KanbanCardToKanbanLabel";

-- DropTable
DROP TABLE "kanban_activity";

-- DropTable
DROP TABLE "kanban_attachment";

-- DropTable
DROP TABLE "kanban_board";

-- DropTable
DROP TABLE "kanban_card";

-- DropTable
DROP TABLE "kanban_column";

-- DropTable
DROP TABLE "kanban_comment";

-- DropTable
DROP TABLE "kanban_label";

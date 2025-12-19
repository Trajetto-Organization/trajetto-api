import { z } from "zod";

import { createKanbanColumnSchema } from "@/schemas/create-kanban-column-schema";
import { updateKanbanColumnSchema } from "@/schemas/update-kanban-column-schema";

import { updateDeleteKanbanColumnSchema } from "@/schemas/update-delete-kanban-column-schema";

import { createKanbanCardSchema } from "@/schemas/create-kanban-card-schema";
import { updateKanbanCardSchema } from "@/schemas/update-kanban-card-schema";

import { updateDeleteKanbanCardSchema } from "@/schemas/update-delete-kanban-card-schema";
import { reorderKanbanColumnsSchema } from "@/schemas/reorder-kanban-columns-schema";

import { reorderKanbanCardsSchema } from "@/schemas/reorder-kanban-cards-schema";
import { listKanbanQuerySchema } from "@/schemas/list-kanban-query-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

const kanbanSchemas = {
  createColumn: createKanbanColumnSchema,
  updateColumn: updateKanbanColumnSchema,
  updateDeleteColumn: updateDeleteKanbanColumnSchema,
  createCard: createKanbanCardSchema,
  updateCard: updateKanbanCardSchema,
  updateDeleteCard: updateDeleteKanbanCardSchema,
  reorderColumns: reorderKanbanColumnsSchema,
  reorderCards: reorderKanbanCardsSchema,
  listKanban: listKanbanQuerySchema,
  businessIdParam: updateDeleteBusinessSchema,
};

const kanbanResponses = {
  columnCreated: z.object({
    message: z.string().default("Coluna criada com sucesso!"),
  }),
  columnUpdated: z.object({
    message: z.string().default("Coluna atualizada com sucesso!"),
  }),
  columnDeleted: z.object({
    message: z.string().default("Coluna deletada com sucesso!"),
  }),
  columnsReordered: z.object({
    message: z.string().default("Colunas reordenadas com sucesso!"),
  }),
  cardCreated: z.object({
    message: z.string().default("Card criado com sucesso!"),
  }),
  cardUpdated: z.object({
    message: z.string().default("Card atualizado com sucesso!"),
  }),
  cardDeleted: z.object({
    message: z.string().default("Card deletado com sucesso!"),
  }),
  cardsReordered: z.object({
    message: z.string().default("Cards reordenados com sucesso!"),
  }),
  kanbanList: z.object({
    data: z.array(
      z.object({
        id: z.string().describe("Column ID"),
        title: z.string().describe("Column title"),
        color: z.string().describe("Column color in hexadecimal format"),
        position: z.number().describe("Column position in the board"),
        businessId: z.string().describe("Business ID"),
        created_at: z.string().describe("Column creation timestamp"),
        updated_at: z.string().describe("Column last update timestamp"),
        cards: z
          .array(
            z.object({
              id: z.string().describe("Card ID"),
              title: z.string().describe("Card title"),
              description: z.string().describe("Card description"),
              priority: z
                .enum(["low", "medium", "high", "urgent"])
                .describe("Card priority level"),
              dueDate: z.string().describe("Card due date"),
              completed: z.boolean().describe("Whether the card is completed"),
              position: z.number().describe("Card position within the column"),
              columnId: z.string().describe("Parent column ID"),
              assignedUserId: z
                .string()
                .nullable()
                .describe("Assigned user ID"),
              created_at: z.string().describe("Card creation timestamp"),
              updated_at: z.string().describe("Card last update timestamp"),
              assignedUser: z
                .object({
                  id: z.string().describe("User ID"),
                  name: z.string().describe("User name"),
                  email: z.string().describe("User email"),
                })
                .nullable()
                .describe("Assigned user information"),
            }),
          )
          .describe("Cards within this column"),
      }),
    ),
    total: z.number().describe("Total number of columns"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),
  kanbanColumnNotFound: z.object({
    message: z.string().default("Coluna do kanban não encontrada!"),
  }),
  kanbanCardNotFound: z.object({
    message: z.string().default("Card do kanban não encontrado!"),
  }),
  validationError: z.object({
    message: z.string().default("Erro de validação"),
    issues: z.array(z.string()).describe("List of validation errors"),
  }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { kanbanSchemas, kanbanResponses };

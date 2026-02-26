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
  // ===== SUCCESS RESPONSES (2xx) =====
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
        created_at: z
          .string()
          .describe("Column creation timestamp in ISO 8601 format"),
        updated_at: z
          .string()
          .describe("Column last update timestamp in ISO 8601 format"),
        cards: z
          .array(
            z.object({
              id: z.string().describe("Card ID"),
              title: z.string().describe("Card title"),
              description: z.string().describe("Card description"),
              priority: z
                .enum(["low", "medium", "high", "urgent"])
                .describe("Card priority level"),
              dueDate: z.string().describe("Card due date in ISO 8601 format"),
              completed: z.boolean().describe("Whether the card is completed"),
              position: z.number().describe("Card position within the column"),
              columnId: z.string().describe("Parent column ID"),
              assignedUserId: z
                .string()
                .nullable()
                .describe("Assigned user ID"),
              created_at: z
                .string()
                .describe("Card creation timestamp in ISO 8601 format"),
              updated_at: z
                .string()
                .describe("Card last update timestamp in ISO 8601 format"),
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

  // ===== BAD REQUEST ERRORS (400) =====
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),
  validationError: z.object({
    message: z.string().default("Erro de validação"),
    issues: z.array(z.string()).describe("List of validation errors"),
  }),
  userAssignedUserNotFound: z.object({
    message: z.string().default("Usuário atribuído não encontrado."),
  }),
  userNotBelongBusiness: z.object({
    message: z.string().default("Este usuário não pertence a esta empresa!"),
  }),
  kanbanInvalidPosition: z.object({
    message: z.string().default("Posição inválida para reordenação."),
  }),
  kanbanOneOrMoreColumnNotBelongBusiness: z.object({
    message: z
      .string()
      .default("Uma ou mais colunas não pertencem a esta empresa."),
  }),

  // ===== FORBIDDEN ERRORS (403) =====
  kanbanNotAllowedCreateColumn: z.object({
    message: z
      .string()
      .default("Você não tem permissão para criar colunas nesta empresa."),
  }),
  kanbanNotAllowedUpdateColumn: z.object({
    message: z
      .string()
      .default("Você não tem permissão para editar colunas nesta empresa."),
  }),
  kanbanNotAllowedDeleteColumn: z.object({
    message: z
      .string()
      .default("Você não tem permissão para deletar colunas nesta empresa."),
  }),
  kanbanNotAllowedReorderColumn: z.object({
    message: z
      .string()
      .default(
        "Você não tem permissão para reordenar as colunas nesta empresa.",
      ),
  }),
  kanbanNotAllowedCreateCard: z.object({
    message: z
      .string()
      .default("Você não tem permissão para criar cards nesta empresa."),
  }),
  kanbanNotAllowedUpdateCard: z.object({
    message: z
      .string()
      .default("Você não tem permissão para editar cards nesta empresa."),
  }),
  kanbanNotAllowedDeleteCard: z.object({
    message: z
      .string()
      .default("Você não tem permissão para deletar cards nesta empresa."),
  }),
  kanbanNotAllowedReorderCard: z.object({
    message: z
      .string()
      .default("Você não tem permissão para reordenar os cards nesta empresa."),
  }),
  kanbanNotAllowedViewBoard: z.object({
    message: z
      .string()
      .default(
        "Você não tem permissão para visualizar o kanban nesta empresa.",
      ),
  }),
  kanbanColumnNotBelongBusiness: z.object({
    message: z.string().default("Esta coluna não pertence a esta empresa!"),
  }),
  kanbanCardNotBelongBusiness: z.object({
    message: z.string().default("Este card não pertence a esta empresa!"),
  }),

  // ===== NOT FOUND ERRORS (404) =====
  kanbanColumnNotFound: z.object({
    message: z.string().default("Coluna do kanban não encontrada."),
  }),
  kanbanCardNotFound: z.object({
    message: z.string().default("Card do kanban não encontrado."),
  }),
  kanbanCardColumnNotFound: z.object({
    message: z.string().default("Coluna do card não encontrada."),
  }),

  // ===== SERVER ERRORS (500) =====
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  // ===== COMPOSITE RESPONSES BY ROUTE =====
  createColumnErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()).describe("List of validation errors"),
    }),
  ]),

  updateColumnErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()).describe("List of validation errors"),
    }),
  ]),

  updateColumnForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default("Você não tem permissão para editar colunas nesta empresa."),
    }),
    z.object({
      message: z.string().default("Esta coluna não pertence a esta empresa!"),
    }),
  ]),

  deleteColumnErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),

  deleteColumnForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default("Você não tem permissão para deletar colunas nesta empresa."),
    }),
    z.object({
      message: z.string().default("Esta coluna não pertence a esta empresa!"),
    }),
  ]),

  reorderColumnsErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Posição inválida para reordenação."),
    }),
    z.object({
      message: z
        .string()
        .default("Uma ou mais colunas não pertencem a esta empresa."),
    }),
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()).describe("List of validation errors"),
    }),
  ]),

  listKanbanErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),

  createCardErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Usuário atribuído não encontrado."),
    }),
    z.object({
      message: z.string().default("Este usuário não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()).describe("List of validation errors"),
    }),
  ]),

  updateCardErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Usuário atribuído não encontrado."),
    }),
    z.object({
      message: z.string().default("Este usuário não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()).describe("List of validation errors"),
    }),
  ]),

  updateCardNotFoundErrors: z.union([
    z.object({
      message: z.string().default("Card do kanban não encontrado."),
    }),
    z.object({
      message: z.string().default("Coluna do card não encontrada."),
    }),
  ]),

  deleteCardNotFoundErrors: z.union([
    z.object({
      message: z.string().default("Card do kanban não encontrado."),
    }),
    z.object({
      message: z.string().default("Coluna do card não encontrada."),
    }),
  ]),

  reorderCardsErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()).describe("List of validation errors"),
    }),
  ]),
};

export { kanbanSchemas, kanbanResponses };

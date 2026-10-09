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

import { errorResponse } from "./common-responses";

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

/** An error answered by the global handler: a stable code and a sentence. */
const coded = (code: string, message: string, codeDescription?: string) =>
  z.object({
    code: z
      .string()
      .default(code)
      .describe(codeDescription ?? `Código estável do erro: ${code}.`),
    message: z.string().default(message),
  });

const plain = (message: string) => z.object({ message: z.string().default(message) });

/** A refusal that can carry one of several codes, listed in the description. */
const refusal = (description: string) => errorResponse.describe(description);

const VALIDATION = "VALIDATION_ERROR (parâmetro, consulta ou corpo recusado; issues diz qual)";
const SESSION_USER = "USER_NOT_FOUND (o usuário da sessão não existe mais)";
const BUSINESS = "BUSINESS_NOT_FOUND (a empresa não existe)";
const ASSIGNEE =
  "ASSIGNED_USER_NOT_FOUND (o responsável indicado não existe ou é de outra empresa — a mesma resposta) ou USER_NOT_IN_BUSINESS (só para o MASTER, que enxerga todas as empresas: o responsável é de outra empresa)";

const validationError = refusal(`${VALIDATION}.`);

/**
 * 403: the profile lacks kanban_manage, or the path/body names another
 * company's board (the route's tenant guard or the use case). A column or
 * card id is never answered with 403: see the 404s.
 */
const forbidden = coded(
  "PERMISSION_DENIED",
  "Você não tem permissão para realizar esta ação nesta empresa.",
  "PERMISSION_DENIED (perfil sem a permissão kanban_manage ou quadro de outra empresa), TENANT_ACCESS_DENIED (a empresa do caminho não é a sua) ou TENANT_INACTIVE (empresa inativa).",
);

/** 404 for a card: missing, or on another company's board — one answer. */
const cardNotFound = coded(
  "KANBAN_CARD_NOT_FOUND",
  "Card do kanban não encontrado.",
  "KANBAN_CARD_NOT_FOUND (o card não existe, é de outra empresa ou foi excluído no meio da operação), KANBAN_COLUMN_NOT_FOUND (a coluna de destino não existe, é de outra empresa ou foi excluída no meio da operação) ou USER_NOT_FOUND (o usuário da sessão não existe mais).",
);

const boardChanged = coded(
  "KANBAN_BOARD_CHANGED",
  "O quadro mudou enquanto a alteração era feita. Atualize e tente novamente.",
  "KANBAN_BOARD_CHANGED: o card mudou de coluna repetidas vezes durante a operação (quadro sendo editado por outras pessoas).",
);

/** 404 of a board-level route: the session user or the company is gone. */
const boardNotFound = refusal(`${SESSION_USER} ou ${BUSINESS}.`);

const internalServerError = plain("Internal server error");

const kanbanResponses = {
  // ===== 2xx =====
  columnCreated: plain("Coluna criada com sucesso!"),
  columnUpdated: plain("Coluna atualizada com sucesso!"),
  columnDeleted: plain("Coluna deletada com sucesso!"),
  columnsReordered: plain("Colunas reordenadas com sucesso!"),
  cardCreated: plain("Card criado com sucesso!"),
  cardUpdated: plain("Card atualizado com sucesso!"),
  cardDeleted: plain("Card deletado com sucesso!"),
  cardsReordered: plain("Cards reordenados com sucesso!"),

  /** One line of the board stream: a column and its cards. */
  kanbanList: z.object({
    id: z.string().describe("ID da coluna"),
    title: z.string().describe("Título da coluna"),
    color: z.string().describe("Cor da coluna em hexadecimal"),
    position: z.number().describe("Posição da coluna no quadro (0, 1, 2… sem buracos)"),
    businessId: z.string().describe("ID da empresa dona do quadro"),
    cardsCount: z.number().describe("Quantos cards a coluna tem, sem filtro"),
    created_at: z.string().describe("Criação da coluna (ISO 8601)"),
    updated_at: z.string().describe("Última alteração da coluna (ISO 8601)"),
    cards: z
      .array(
        z.object({
          id: z.string().describe("ID do card"),
          title: z.string().describe("Título do card"),
          description: z.string().describe("Descrição do card"),
          priority: z
            .enum(["low", "medium", "high", "urgent"])
            .describe("Prioridade: low, medium, high ou urgent"),
          dueDate: z.string().describe("Prazo (ISO 8601)"),
          completed: z.boolean().describe("Se o card está concluído"),
          position: z.number().describe("Posição do card na coluna"),
          columnId: z.string().describe("ID da coluna"),
          assignedUserId: z.string().nullable().describe("ID do responsável"),
          created_at: z.string().describe("Criação do card (ISO 8601)"),
          updated_at: z.string().describe("Última alteração do card (ISO 8601)"),
          assignedUser: z
            .object({
              id: z.string().describe("ID do usuário"),
              name: z.string().describe("Nome do usuário"),
              email: z.string().describe("E-mail do usuário"),
              avatar: z.string().nullable().describe("URL assinada da foto, ou null"),
            })
            .nullable()
            .describe("O responsável pelo card"),
        }),
      )
      .describe(
        "Cards da coluna. Com busca, a coluna encontrada pelo título mostra todos; as demais, só os cards que batem. Quem não tem leitura completa do Kanban vê só os próprios cards.",
      ),
  }),

  // ===== 4xx / 5xx by route =====
  createColumnErrors: validationError,
  createColumnNotFound: boardNotFound,
  updateColumnErrors: validationError,
  deleteColumnErrors: validationError,
  /** 404 of a column write: the column, the session user or the company. */
  columnWriteNotFound: refusal(
    `KANBAN_COLUMN_NOT_FOUND (inexistente ou de outra empresa — a mesma resposta), ${SESSION_USER} ou ${BUSINESS}.`,
  ),
  reorderColumnsErrors: refusal(
    `${VALIDATION} ou KANBAN_INVALID_POSITION (posição fora do quadro).`,
  ),
  reorderColumnsNotFound: refusal(
    `KANBAN_COLUMN_NOT_FOUND (uma das colunas não existe ou é de outro quadro — a mesma resposta), ${SESSION_USER} ou ${BUSINESS}.`,
  ),
  listKanbanErrors: validationError,
  listKanbanNotFound: boardNotFound,
  createCardErrors: refusal(`${VALIDATION}, ${ASSIGNEE}.`),
  createCardNotFound: refusal(
    `KANBAN_COLUMN_NOT_FOUND (a coluna não existe ou é de outra empresa — a mesma resposta) ou ${SESSION_USER}.`,
  ),
  updateCardErrors: refusal(`${VALIDATION}, ${ASSIGNEE}.`),
  deleteCardErrors: validationError,
  reorderCardsErrors: refusal(
    `${VALIDATION} ou KANBAN_CARD_CROSS_BOARD_MOVE (só o MASTER: mover o card para o quadro de outra empresa).`,
  ),

  forbidden,
  cardNotFound,
  boardChanged,
  internalServerError,
};

export { kanbanSchemas, kanbanResponses };

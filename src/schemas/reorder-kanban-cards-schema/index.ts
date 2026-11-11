import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

/**
 * The web sends every card of the board on a move. About what the default
 * 1 MiB body holds anyway (~100 bytes a card); the cap only bounds what one
 * request can make the API parse.
 */
const MAX_REORDERED_CARDS = 10_000;

const reorderKanbanCardsSchema = z.object({
  ...tenantLockedShape,
  cards: z
    .array(
      z.object({
        id: z.string().uuid("ID do card inválido."),
        position: z
          .number()
          .int()
          .min(0, "Posição deve ser maior ou igual a 0."),
        columnId: z.string().uuid("ID da coluna inválido."),
      }),
    )
    .min(1, "Deve haver pelo menos um card para reordenar.")
    .max(
      MAX_REORDERED_CARDS,
      `Reordene no máximo ${MAX_REORDERED_CARDS.toLocaleString("pt-BR")} cards por vez.`,
    ),
});

export { MAX_REORDERED_CARDS, reorderKanbanCardsSchema };

import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
import { fieldError } from "@/shared/validation/field-error";

/**
 * Marks the caller's notices about one item as read (wave 3): the push never
 * knows the id of its inbox row (they are separate deliveries), so the app
 * names the item instead when it opens it.
 *
 * It edits existing rows (the caller's), so it carries the tenant lock of
 * every edit body (decision 16.100): no company comes from the body, and a
 * `businessId` sent anyway is a 400, not silently stripped.
 */
const readNotificationsByEntitySchema = z.object({
  ...tenantLockedShape,
  type: z
    .string(fieldError({ required: "O tipo do aviso é obrigatório." }))
    .trim()
    .min(1, "O tipo do aviso é obrigatório.")
    .max(64, "O tipo do aviso deve ter no máximo 64 caracteres.")
    .describe(
      "O `type` do aviso, como a caixa de avisos e o push o trazem (ex. service-order, account-payable, kanban-card).",
    ),
  entityId: z
    .string(fieldError({ required: "O ID do item é obrigatório." }))
    .uuid("O ID do item é inválido.")
    .describe("O `entityId` do aviso: o item aberto."),
});

export { readNotificationsByEntitySchema };

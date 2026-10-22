import { z } from "zod";

import { createStatusChangeReasonSchema } from "@/schemas/create-status-change-reason-schema";
import { updateStatusChangeReasonSchema } from "@/schemas/update-status-change-reason-schema";

import { listStatusChangeReasonSchema } from "@/schemas/list-status-change-reason-schema";
import { updateDeleteStatusChangeReasonSchema } from "@/schemas/update-delete-status-change-reason-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

/**
 * Prisma hands back Date objects and the zod serializer validates what the
 * handler passes, so a plain `z.string()` here would reject the endpoint's own
 * real payload with a 500.
 */
const isoDateTime = z.union([z.string(), z.date()]);

const statusChangeReasonEntity = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  businessId: z.string(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});

const statusChangeReasonSchemas = {
  businessIdParam: updateDeleteBusinessSchema,
  reasonBusinessParams: updateDeleteBusinessSchema.merge(
    updateDeleteStatusChangeReasonSchema,
  ),

  createStatusChangeReason: createStatusChangeReasonSchema,
  updateStatusChangeReason: updateStatusChangeReasonSchema,
  listStatusChangeReasons: listStatusChangeReasonSchema,
};

const statusChangeReasonResponses = {
  reasonCreated: z.object({
    message: z.string().default("Motivo criado com sucesso!"),
  }),
  reasonUpdated: z.object({
    message: z.string().default("Motivo atualizado com sucesso!"),
  }),
  reasonDeleted: z.object({
    message: z.string().default("Motivo excluído com sucesso!"),
  }),

  /** One line of the stream, after the envelope. */
  reasonListRow: statusChangeReasonEntity,

  // Not found (caller or company): 404 with a code (decision 11.3).
  lookupNotFound: z
    .object({
      code: z
        .string()
        .describe(
          "USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
        ),
      message: z.string(),
    })
    .describe(
      "USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
    ),
  reasonNotFound: z
    .object({
      code: z
        .string()
        .describe(
          "STATUS_CHANGE_REASON_NOT_FOUND (o motivo não existe ou é de outra empresa — a mesma resposta), USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
        ),
      message: z.string(),
    })
    .describe(
      "STATUS_CHANGE_REASON_NOT_FOUND (o motivo não existe ou é de outra empresa — a mesma resposta), USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
    ),
  codedError: z.object({ code: z.string(), message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { statusChangeReasonSchemas, statusChangeReasonResponses };

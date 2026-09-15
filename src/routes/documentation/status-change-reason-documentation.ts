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

  /**
   * NOT a JSON object: this endpoint streams `application/x-ndjson`, like
   * every other offset listing in the API — an envelope line, then one reason
   * per line. Calling `response.json()` on it throws.
   *
   * `searchMeta` is where the tally lands: sendAsNDJSON nests whatever the use
   * case returned in `meta` under that key.
   */
  reasonListEnvelope: z.object({
    meta: z.object({
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),
      searchMeta: z.object({
        total: z.number(),
        active: z.number(),
        used: z
          .number()
          .describe(
            "Quantos motivos já explicam alguma mudança no histórico — separa o vocabulário real do que foi digitado uma vez e esquecido.",
          ),
      }),
    }),
  }),

  /** One line of the stream, after the envelope. */
  reasonListRow: statusChangeReasonEntity,

  genericError: z.object({ message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { statusChangeReasonSchemas, statusChangeReasonResponses };

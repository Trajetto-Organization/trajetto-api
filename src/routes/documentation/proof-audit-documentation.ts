import { z } from "zod";

import {
  listProofAuditsSchema,
  reviewProofAuditParamsSchema,
  reviewProofAuditSchema,
} from "@/schemas/proof-audit-schema";

const isoDateTime = z.union([z.string(), z.date()]);

const proofAuditSchemas = {
  listProofAudits: listProofAuditsSchema,
  reviewProofAuditParams: reviewProofAuditParamsSchema,
  reviewProofAudit: reviewProofAuditSchema,
};

const proofAuditResponses = {
  /**
   * NOT a JSON object: this endpoint streams `application/x-ndjson` like every
   * other offset listing in the API — an envelope line, then one card per line.
   */
  auditQueueEnvelope: z.object({
    meta: z.object({
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),

      searchMeta: z.object({
        pending: z.number(),
        approved: z.number(),
        rejected: z.number(),

        agreementRate: z
          .number()
          .nullable()
          .describe(
            "Com que frequência a máquina e a pessoa disseram a mesma coisa, sobre os cards revisados que TÊM sugestão. É o único número que responde se a IA vale o que custa, e ele só existe porque a sugestão e o veredito são colunas separadas.",
          ),
      }),
    }),
  }),

  auditReviewed: z.object({ message: z.string() }),

  genericError: z.object({ message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { proofAuditSchemas, proofAuditResponses };
export type { isoDateTime };

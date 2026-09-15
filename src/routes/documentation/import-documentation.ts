import { z } from "zod";

import {
  importSpreadsheetSchema,
  importIdParamSchema,
  listImportsSchema,
} from "@/schemas/import-spreadsheet-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

/**
 * Prisma hands back Date objects and the zod serializer validates what the
 * handler passes, so a plain `z.string()` here would reject the endpoint's own
 * real payload with a 500.
 */
const isoDateTime = z.union([z.string(), z.date()]);

/** What happened to one line of the file, as the operator reads it. */
const importRowResult = z.object({
  line: z
    .number()
    .describe(
      "A linha como ela aparece no canto da planilha, com o cabeçalho sendo a 1 — não um índice.",
    ),
  outcome: z.enum(["imported", "duplicated", "invalid"]),
  recipient_name: z.string().nullable(),
  reference: z.string().nullable(),
  message: z.string().nullable(),
});

const importReport = z.object({
  imported: z.number(),
  duplicated: z.number(),
  invalid: z.number(),

  unknownHeaders: z
    .array(z.string())
    .describe(
      "Colunas do arquivo que não reconhecemos. Nunca impedem a importação; existem para o operador descobrir que digitou o cabeçalho errado.",
    ),

  rows: z.array(importRowResult),

  routes: z.array(
    z.object({
      id: z.string(),
      code: z.number(),
      name: z.string().nullable(),
      stops: z.number(),
    }),
  ),
});

const importEntity = z.object({
  id: z.string(),
  source: z.enum(["SPREADSHEET", "NFE_XML"]),
  status: z.enum(["COMPLETED", "REVERSED"]),

  filename: z.string(),

  imported: z.number(),
  duplicated: z.number(),
  invalid: z.number(),

  report: importReport,

  reversed_at: isoDateTime.nullable(),

  businessId: z.string(),
  performedById: z.string(),

  created_at: isoDateTime,
});

const importSchemas = {
  businessIdParam: updateDeleteBusinessSchema,
  importBusinessParams: updateDeleteBusinessSchema.merge(importIdParamSchema),

  importSpreadsheet: importSpreadsheetSchema,
  listImports: listImportsSchema,
};

const importResponses = {
  spreadsheetImported: z.object({
    message: z.string(),
    data: z.object({
      id: z.string(),
      imported: z.number(),
      duplicated: z.number(),
      invalid: z.number(),
      report: importReport,
    }),
  }),

  importReversed: z.object({
    message: z.string(),
    data: z.object({
      removedDeliveries: z.number(),
      removedRoutes: z.number(),

      keptDeliveries: z.array(
        z.object({
          id: z.string(),
          recipient_name: z.string(),
          reason: z.string(),
        }),
      ),
      keptRoutes: z.array(
        z.object({ id: z.string(), code: z.number(), reason: z.string() }),
      ),
    }),
  }),

  /**
   * NOT a JSON object: this endpoint streams `application/x-ndjson` like every
   * other offset listing in the API — an envelope line, then one upload per
   * line. Calling `response.json()` on it throws.
   */
  importListEnvelope: z.object({
    meta: z.object({
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),
    }),
  }),

  /** One line of the stream, after the envelope. */
  importListRow: importEntity,

  genericError: z.object({ message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { importSchemas, importResponses };

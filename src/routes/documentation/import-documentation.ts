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

  // IN_PROGRESS is real: the record is written before the first row, so an
  // upload still running is listed and can be opened. Left out, the detail
  // route's serializer turned that upload into a 500.
  status: z.enum(["IN_PROGRESS", "COMPLETED", "REVERSED"]),

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

  /** One line of the stream, after the envelope. */
  importListRow: importEntity.extend({
    report: importReport
      .optional()
      .describe(
        "Ausente quando a listagem é pedida com includeReport=false; o relatório de uma importação vem de GET /import/get-import/:importId/business/:businessId.",
      ),
  }),

  /** One upload with its per-row report, when the operator opens it. */
  importDetail: z.object({ data: importEntity }),

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
  spreadsheetNotFound: z
    .object({
      code: z
        .string()
        .describe(
          "SHIPPER_NOT_FOUND (o embarcador informado não existe ou é de outra empresa — a mesma resposta), USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
        ),
      message: z.string(),
    })
    .describe(
      "SHIPPER_NOT_FOUND (o embarcador informado não existe ou é de outra empresa — a mesma resposta), USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
    ),
  importNotFound: z
    .object({
      code: z
        .string()
        .describe(
          "IMPORT_NOT_FOUND (a importação não existe ou é de outra empresa — a mesma resposta), USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
        ),
      message: z.string(),
    })
    .describe(
      "IMPORT_NOT_FOUND (a importação não existe ou é de outra empresa — a mesma resposta), USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
    ),
  codedError: z.object({ code: z.string(), message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { importSchemas, importResponses };

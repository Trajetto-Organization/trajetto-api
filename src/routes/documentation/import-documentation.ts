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

const keptDelivery = z.object({
  id: z.string(),
  recipient_name: z.string(),
  reason: z.string(),
});

const keptRoute = z.object({
  id: z.string(),
  code: z.number(),
  reason: z.string(),
});

/** The undo as the client follows it (services/import-reversal.ts). */
const reversalView = z
  .object({
    state: z
      .enum(["RUNNING", "INTERRUPTED", "DONE"])
      .describe(
        "RUNNING: o estorno está removendo as entregas, em lotes. INTERRUPTED: parou no meio (falha ou servidor reiniciado); o que já foi removido está contado aqui, a importação continua COMPLETED e pedir o estorno de novo continua de onde parou. DONE: terminou, e a importação está REVERSED.",
      ),
    removedDeliveries: z.number(),
    removedRoutes: z.number(),
    keptDeliveries: z.array(keptDelivery),
    keptRoutes: z.array(keptRoute),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .describe(
    "O estorno desta importação: o que já foi removido e o que foi mantido (com o motivo), lote a lote; no fim, o resultado. Nulo quando ninguém pediu o estorno.",
  );

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

  // Only on the detail (GET /import/get-import): the listing leaves it out.
  reversal: reversalView.nullable().optional(),

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
  /**
   * The upload accepted and queued (202). Same envelope the synchronous
   * answer had, so a client that only read `data.id` and the counters keeps
   * working; the counters are zero and `status` is IN_PROGRESS until the
   * record is closed.
   */
  spreadsheetAccepted: z.object({
    message: z.string(),
    data: z.object({
      id: z
        .string()
        .describe(
          "A importação. Acompanhe por GET /import/get-import/:importId/business/:businessId até `status` deixar de ser IN_PROGRESS.",
        ),
      status: z.enum(["IN_PROGRESS", "COMPLETED", "REVERSED"]),
      imported: z.number(),
      duplicated: z.number(),
      invalid: z.number(),
      report: importReport.describe(
        "Vazio enquanto a importação roda: o relatório linha a linha vem de GET /import/get-import quando `status` for COMPLETED.",
      ),
    }),
  }),

  importReversed: z.object({
    message: z.string(),
    data: z.object({
      removedDeliveries: z.number(),
      removedRoutes: z.number(),

      keptDeliveries: z.array(keptDelivery),
      keptRoutes: z.array(keptRoute),
    }),
  }),

  /**
   * The undo of a big upload accepted and running in the background (202),
   * or one already running that this click now follows.
   */
  importReversalAccepted: z.object({
    message: z.string(),
    data: z.object({
      id: z
        .string()
        .describe(
          "A importação. Acompanhe por GET /import/get-import/:importId/business/:businessId até `status` virar REVERSED (ou `reversal.state` virar INTERRUPTED).",
        ),
      status: z.enum(["IN_PROGRESS", "COMPLETED", "REVERSED"]),
      reversal: reversalView.nullable(),
    }),
  }),

  /** One line of the stream, after the envelope. */
  importListRow: importEntity.extend({
    report: importReport
      .optional()
      .describe(
        "Só presente quando a listagem é pedida com includeReport=true; o relatório de uma importação vem de GET /import/get-import/:importId/business/:businessId.",
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

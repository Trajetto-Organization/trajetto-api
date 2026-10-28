import { z } from "zod";

import { facetField, sortFields } from "@/shared/pagination/list-query";
import { pageField, pageSizeField } from "@/shared/pagination/page-size";
import {
  IMPORT_SORT_FALLBACK,
  IMPORT_SORT_KEYS,
  IMPORT_SOURCES,
  IMPORT_STATUSES,
} from "@/modules/import/usecases/list-imports/import-list";

/**
 * One file per request, and a cap that is not arbitrary.
 *
 * 8 MB of base64 is roughly 6 MB of spreadsheet, which at the sizes these
 * files run is tens of thousands of rows — far past what one dispatcher loads
 * in a morning, and well short of what would hold a Node process hostage while
 * exceljs parses it.
 */
const MAX_SPREADSHEET_BASE64 = 8 * 1024 * 1024;

const importSpreadsheetSchema = z.object({
  filename: z
    .string({ required_error: "O nome do arquivo é obrigatório." })
    .max(255, "O nome do arquivo deve ter no máximo 255 caracteres.")
    .refine(
      (value) => /\.(xlsx|csv)$/i.test(value),
      "Envie um arquivo .xlsx ou .csv.",
    )
    .describe("Decide como o arquivo é lido, e aparece no relatório."),

  content: z
    .string({ required_error: "O conteúdo do arquivo é obrigatório." })
    .min(1, "O arquivo está vazio.")
    .max(
      MAX_SPREADSHEET_BASE64,
      "O arquivo excede o tamanho permitido para importação.",
    )
    .describe("O arquivo em base64."),

  shipperId: z
    .string({ required_error: "O embarcador é obrigatório." })
    .uuid("O embarcador deve ter um identificador válido.")
    .describe(
      "Um upload é a carga de um embarcador. Uma planilha que mistura embarcadores são dois uploads.",
    ),
});

const listImportsSchema = z.object({
  page: pageField(),
  pageSize: pageSizeField(10),
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),

  // Optional and false by default: the tab's generic list fetch never sent
  // the flag, and every page carried each upload's per-row report (MBs
  // serialized on the event loop) to draw four counters. No web or app build
  // reads the report from the row: the dialog fetches it from get-import.
  includeReport: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
    .describe(
      "true inclui o relatório por linha em cada item. Ausente ou false, cada item traz só os contadores; o relatório de uma importação vem de GET /import/get-import/:importId/business/:businessId.",
    ),

  ...sortFields(IMPORT_SORT_KEYS, IMPORT_SORT_FALLBACK),
  status: facetField(IMPORT_STATUSES, "Status da importação."),
  source: facetField(IMPORT_SOURCES, "Origem: planilha ou XML da NF-e."),
});

const importIdParamSchema = z.object({
  importId: z
    .string({ required_error: "ID da importação é obrigatório!" })
    .uuid("ID da importação é inválido."),
});

export {
  MAX_SPREADSHEET_BASE64,
  importIdParamSchema,
  importSpreadsheetSchema,
  listImportsSchema,
};

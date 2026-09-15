import { z } from "zod";

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
  page: z
    .string()
    .transform((value) => Number(value) || 1)
    .refine((value) => value >= 1, "A página é obrigatória!"),
  pageSize: z
    .string()
    .transform((value) => Number(value) || 10)
    .refine(
      (value) => value >= 1 && value <= 100,
      "A quantidade de itens por página deve estar entre 1 e 100.",
    ),
  businessId: z.string().uuid("ID da empresa é inválido.").optional(),
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

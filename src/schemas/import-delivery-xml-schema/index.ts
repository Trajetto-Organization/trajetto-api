import { z } from "zod";

/** One NF-e is a few KB; the cap keeps a single request bounded. */
const MAX_FILES_PER_IMPORT = 25;
const MAX_XML_SIZE = 512 * 1024;

const importDeliveryXmlSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z
          .string()
          .max(255, "O nome do arquivo deve ter no máximo 255 caracteres.")
          .describe("Nome do arquivo — usado apenas no relatório de importação."),
        content: z
          .string()
          .min(1, "O conteúdo do arquivo não pode estar vazio.")
          .max(MAX_XML_SIZE, "Um dos arquivos excede o tamanho permitido."),
      }),
    )
    .min(1, "Envie ao menos um arquivo XML.")
    .max(
      MAX_FILES_PER_IMPORT,
      `Envie no máximo ${MAX_FILES_PER_IMPORT} arquivos por vez.`,
    ),
  shipperId: z
    .string()
    .uuid("ID do embarcador é inválido.")
    .optional()
    .describe(
      "Força o embarcador de todas as notas. Sem ele, o emitente da NF-e é usado (casado por CNPJ, criado se não existir).",
    ),
  scheduled_date: z.coerce
    .date()
    .optional()
    .describe("Data prevista aplicada a todas as entregas importadas."),
});

export { importDeliveryXmlSchema, MAX_FILES_PER_IMPORT, MAX_XML_SIZE };

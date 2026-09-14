import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

const listOccurrencesSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  occurrenceTypeId: z
    .string()
    .uuid("ID do tipo de ocorrência é inválido.")
    .optional()
    .describe("Filtra por um tipo de ocorrência específico."),
  // Querystrings are strings; the transform hands the use case a boolean.
  blocksDelivery: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true"))
    .describe("true = só impeditivas; false = só informativas."),
});

export { listOccurrencesSchema };

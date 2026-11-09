import { z } from "zod";

/**
 * The company a read of one record is scoped to (wave 3). Only the MASTER
 * needs it, the way the listings receive `businessId`; anyone else may leave
 * it out (and naming another company is refused by the tenant guard).
 */
const selectedCompanyQuerySchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "A empresa escolhida. Obrigatória só para o MASTER; os demais leem a própria empresa.",
    ),
});

/**
 * The same company, optional for everyone: a record that names its own
 * company (a Kanban card, through its column) needs none, and a MASTER who
 * names one only narrows the read to it.
 */
const optionalCompanyQuerySchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Opcional. Para o MASTER, restringe a leitura a esta empresa; os demais leem só a própria.",
    ),
});

export { optionalCompanyQuerySchema, selectedCompanyQuerySchema };

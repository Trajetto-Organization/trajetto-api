import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

const listStatusChangeReasonSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
});

export { listStatusChangeReasonSchema };

import { z } from "zod";

const updateDeleteOccurrenceTypeSchema = z.object({
  occurrenceTypeId: z
    .string({ required_error: "ID do tipo de ocorrência é obrigatório!" })
    .uuid("ID do tipo de ocorrência é inválido."),
});

export { updateDeleteOccurrenceTypeSchema };

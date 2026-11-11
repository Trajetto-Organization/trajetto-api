import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteOccurrenceTypeSchema = z.object({
  occurrenceTypeId: z
    .string(fieldError({ required: "ID do tipo de ocorrência é obrigatório!" }))
    .uuid("ID do tipo de ocorrência é inválido."),
});

export { updateDeleteOccurrenceTypeSchema };

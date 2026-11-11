import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteFineSchema = z.object({
  fineId: z
    .string(fieldError({ required: "ID da multa é obrigatório!" }))
    .uuid("ID da multa é inválido."),
});

export { updateDeleteFineSchema };

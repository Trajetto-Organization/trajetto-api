import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteStatusChangeReasonSchema = z.object({
  reasonId: z
    .string(fieldError({ required: "ID do motivo é obrigatório!" }))
    .uuid("ID do motivo é inválido."),
});

export { updateDeleteStatusChangeReasonSchema };

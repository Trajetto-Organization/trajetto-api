import { z } from "zod";

const updateDeleteStatusChangeReasonSchema = z.object({
  reasonId: z
    .string({ required_error: "ID do motivo é obrigatório!" })
    .uuid("ID do motivo é inválido."),
});

export { updateDeleteStatusChangeReasonSchema };

import { z } from "zod";

const updateDeleteFineSchema = z.object({
  fineId: z
    .string({ required_error: "ID da multa é obrigatório!" })
    .uuid("ID da multa é inválido."),
});

export { updateDeleteFineSchema };

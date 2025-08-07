import { z } from "zod";

const updateDeletePartSchema = z.object({
  partId: z.string().uuid("O ID da peça é obrigatório!"),
});

export { updateDeletePartSchema };

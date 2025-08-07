import { z } from "zod";

const updateDeleteUserSchema = z.object({
  userId: z.string().min(1, "O ID do usuário é obrigatório!"),
});

export { updateDeleteUserSchema };

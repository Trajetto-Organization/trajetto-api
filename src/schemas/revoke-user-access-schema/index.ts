import { z } from "zod";

const revokeUserAccessSchema = z.object({
  userId: z.string().min(1, "O ID do usuário é obrigatório!"),
});

export { revokeUserAccessSchema };

import { z } from "zod";

const revokeUserAccessSchema = z.object({
  userId: z
    .string({ required_error: "ID do usuário é obrigatório!" })
    .uuid("ID do usuário é inválido."),
});

export { revokeUserAccessSchema };

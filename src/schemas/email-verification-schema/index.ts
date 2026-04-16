import { z } from "zod";

const emailVerificationVerificationSchema = z.object({
  token: z
    .string({ required_error: "ID do token é obrigatório!" })
    .uuid("ID do token é inválido!"),
});

export { emailVerificationVerificationSchema };

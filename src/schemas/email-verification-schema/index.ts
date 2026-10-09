import { z } from "zod";

const emailVerificationVerificationSchema = z.object({
  token: z
    .string({ required_error: "ID do token é obrigatório!" })
    .uuid("ID do token é inválido!")
    .describe("O token do link de confirmação enviado por e-mail."),
});

export { emailVerificationVerificationSchema };

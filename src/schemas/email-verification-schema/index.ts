import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const emailVerificationVerificationSchema = z.object({
  token: z
    .string(fieldError({ required: "ID do token é obrigatório!" }))
    .uuid("ID do token é inválido!")
    .describe("O token do link de confirmação enviado por e-mail."),
});

export { emailVerificationVerificationSchema };

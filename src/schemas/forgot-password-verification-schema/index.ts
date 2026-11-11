import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const forgotPasswordVerificationSchema = z.object({
  token: z
    .string(fieldError({ required: "ID do token é obrigatório!" }))
    .uuid("ID do token é inválido.")
    .describe("O token do link de recuperação enviado por e-mail."),
});

export { forgotPasswordVerificationSchema };

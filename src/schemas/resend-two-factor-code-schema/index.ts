import { z } from "zod";

const resendTwoFactorCodeSchema = z.object({
  email: z
    .string()
    .min(1, "O e-mail é obrigatório.")
    .email("O e-mail informado não é válido.")
    .max(100, "O e-mail deve ter no máximo 100 caracteres."),
});

export { resendTwoFactorCodeSchema };

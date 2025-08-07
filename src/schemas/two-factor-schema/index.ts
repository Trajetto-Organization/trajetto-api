import { z } from "zod";

const twoFactorUserSchema = z.object({
  email: z
    .string()
    .min(1, "O e-mail é obrigatório.")
    .email("O e-mail informado não é válido.")
    .max(100, "O e-mail deve ter no máximo 100 caracteres."),
  code: z
    .string()
    .regex(
      /^\d{6}$/,
      "O código de verificação deve conter exatamente 6 dígitos numéricos.",
    ),
});

export { twoFactorUserSchema };

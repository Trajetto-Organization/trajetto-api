import { z } from "zod";

const resendTwoFactorCodeSchema = z.object({
  email: z
    .string()
    .min(1, "O e-mail é obrigatório.")
    .email("O e-mail informado não é válido.")
    .max(100, "O e-mail deve ter no máximo 100 caracteres."),
  // What the password step returned (twoFactorChallenge). Always required by
  // the use case; optional here so a missing one gets the same answer as a
  // wrong one instead of a validation error that tells them apart.
  challenge: z.string().min(1).max(2048).optional(),
});

export { resendTwoFactorCodeSchema };

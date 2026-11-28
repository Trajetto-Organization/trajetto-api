import { z } from "zod";

import { sessionDeviceIdField } from "@/schemas/driver-access-schema";

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
  // What the password step returned (twoFactorChallenge). Always required by
  // the use case; optional here so a missing one gets the same answer as a
  // wrong one instead of a validation error that tells them apart.
  challenge: z.string().min(1).max(2048).optional(),
  // Wave 2: a challenge started by a CPF login names its phone; the code is
  // then accepted only with that phone's id, and the session is bound to it.
  deviceId: sessionDeviceIdField
    .optional()
    .describe(
      "Só quando o desafio veio de um login por CPF: o mesmo `deviceId` daquele login. A sessão fica presa ao aparelho.",
    ),
});

export { twoFactorUserSchema };

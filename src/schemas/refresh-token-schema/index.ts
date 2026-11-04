import { z } from "zod";

const refreshTokenSchema = z.object({
  token: z.string().min(1, "O token é obrigatório!"),
  // Plan of 02/11/2026, D4: a session bound to a phone (opened by the QR
  // code or by CPF and password) is renewed only with that phone's id. Any
  // other session ignores it, so the app may always send it.
  deviceId: z
    .string()
    .max(64, "O identificador do aparelho deve ter no máximo 64 caracteres.")
    .optional()
    .describe(
      "O identificador do aparelho (Android ID de 16 dígitos hexadecimais, ou o UUID da instalação). Obrigatório para renovar uma sessão aberta pelo QR Code ou por CPF e senha com o aparelho; ignorado nas demais.",
    ),
});

export { refreshTokenSchema };

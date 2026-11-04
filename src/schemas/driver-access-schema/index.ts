import { z } from "zod";

import { normalizeCpf } from "@/modules/user/services/driver-cpf";
import { normalizeDeviceId } from "@/shared/delivery/proof-capture";

/**
 * The fields of the driver's own ways in (plan of 02/11/2026, D3/D4/D8): the
 * phone's id, which a QR or CPF session is bound to, and the CPF typed at the
 * login.
 */

/**
 * The phone, as the app identifies it everywhere (the proofs carry the same
 * id): the Android ID, 16 hex digits, or the UUID the app keeps when the
 * phone gives none. Stored and compared in lower case. Unlike the proof's
 * advisory `device_id`, a session is bound to it, so anything else is
 * refused rather than dropped.
 */
const sessionDeviceIdField = z
  .string({ required_error: "O identificador do aparelho é obrigatório." })
  .max(64, "Identificador do aparelho inválido.")
  .transform((value, ctx) => {
    const normalized = normalizeDeviceId(value);

    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Identificador do aparelho inválido: envie o Android ID (16 dígitos hexadecimais) ou o UUID da instalação.",
      });

      return z.NEVER;
    }

    return normalized;
  })
  .describe(
    "O identificador do aparelho: Android ID (16 dígitos hexadecimais) ou o UUID da instalação. A sessão fica presa a ele.",
  );

/** The CPF, masked or not; the 11 digits when its check digits match. */
const driverCpfField = z
  .string({ required_error: "O CPF é obrigatório." })
  .max(20, "O CPF informado não é válido.")
  .transform((value, ctx) => {
    const normalized = normalizeCpf(value);

    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O CPF informado não é válido.",
      });

      return z.NEVER;
    }

    return normalized;
  })
  .describe("O CPF do motorista, com ou sem máscara.");

/**
 * POST /user/session/enroll: the QR code's opaque token, or the 8-character
 * code read out instead, and the phone that consumes it. Exactly one of the
 * two. The names are distinct on purpose: the logger censors them by name
 * (shared/logging/logger.ts), and a bare `token` or `code` would collide with
 * what every other line logs.
 */
const enrollSessionSchema = z
  .object({
    qrToken: z
      .string()
      .min(1, "O QR Code é inválido.")
      .max(200, "O QR Code é inválido.")
      .optional()
      .describe(
        "O token lido do QR Code (só o token, sem o prefixo do conteúdo).",
      ),
    accessCode: z
      .string()
      .min(1, "O código de acesso é inválido.")
      .max(32, "O código de acesso é inválido.")
      .optional()
      .describe(
        "O código de acesso de 8 caracteres, com ou sem hífen e espaços, maiúsculas ou minúsculas.",
      ),
    deviceId: sessionDeviceIdField,
  })
  .superRefine((data, ctx) => {
    if (Boolean(data.qrToken) === Boolean(data.accessCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["qrToken"],
        message: "Envie o QR Code ou o código de acesso (um dos dois).",
      });
    }
  });

/** The driver's login a manager acts on (D2, D3, D7). */
const driverLoginParamsSchema = z.object({
  userId: z
    .string({ required_error: "ID do usuário é obrigatório!" })
    .uuid("ID do usuário é inválido."),
});

/** DELETE /user/:userId/devices/:deviceId (D7). */
const driverDeviceParamsSchema = driverLoginParamsSchema.extend({
  deviceId: sessionDeviceIdField,
});

/** POST /user/session/revoke (A3): the refresh token of the session to end. */
const revokeSessionSchema = z.object({
  token: z
    .string({ required_error: "O token é obrigatório!" })
    .min(1, "O token é obrigatório!")
    .max(4096, "Token de atualização inválido.")
    .describe("O refresh token da sessão a encerrar (mesmo vencido)."),
});

export {
  driverCpfField,
  driverDeviceParamsSchema,
  driverLoginParamsSchema,
  enrollSessionSchema,
  revokeSessionSchema,
  sessionDeviceIdField,
};

import { z } from "zod";

import {
  driverCpfField,
  sessionDeviceIdField,
} from "@/schemas/driver-access-schema";

const emailField = z
  .string()
  .min(1, "O e-mail é obrigatório.")
  .email("O e-mail informado não é válido.")
  .max(100, "O e-mail deve ter no máximo 100 caracteres.");

/**
 * The password rule of every login and of every password a person sets for
 * another (the driver's initial password, D2): one definition.
 */
const passwordField = z
  .string()
  .min(7, "A senha deve ter pelo menos 7 caracteres.")
  .max(100, "A senha deve ter no máximo 100 caracteres.");

const authenticateUserSchema = z.object({
  email: emailField,
  password: passwordField,
});

/**
 * POST /user/session: e-mail and password, as every client has always sent,
 * or the driver's CPF and password (plan of 02/11/2026, D8; decision D02).
 *
 * One object with both identifiers optional, not a union: a union answers a
 * malformed e-mail with zod's "Invalid input" instead of the field's own
 * sentence, and the app N-1 and the web keep sending `{ email, password }`
 * untouched. `businessId` is the company the driver picked when the CPF and
 * password matched in more than one; `deviceId` binds the session to the
 * phone (D4). Both belong to the CPF login only.
 */
const sessionLoginSchema = z
  .object({
    email: emailField.optional(),
    cpf: driverCpfField.optional(),
    password: passwordField,
    businessId: z
      .string()
      .uuid("ID da empresa é inválido.")
      .optional()
      .describe(
        "Só no login por CPF: a empresa escolhida, quando o CPF e a senha valem em mais de uma (a resposta anterior trouxe `businesses`).",
      ),
    deviceId: sessionDeviceIdField
      .optional()
      .describe(
        "Login por CPF: o aparelho (Android ID ou UUID da instalação). Com ele a sessão fica presa ao aparelho e dura até 30 dias sem uso e 180 no total. Ignorado no login por e-mail.",
      ),
  })
  .superRefine((data, ctx) => {
    if (data.email === undefined && data.cpf === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["email"],
        message: "O e-mail é obrigatório.",
      });

      return;
    }

    if (data.email !== undefined && data.cpf !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cpf"],
        message: "Entre com o e-mail ou com o CPF, não com os dois.",
      });

      return;
    }

    // A company in the body is refused, never ignored: by e-mail the account
    // already names its own. A `deviceId` is only ignored there, so an app
    // that always sends it still signs in by e-mail (unbound, as before).
    if (data.email !== undefined && data.businessId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["businessId"],
        message: "A empresa só é escolhida no login do motorista por CPF.",
      });
    }
  });

export { authenticateUserSchema, passwordField, sessionLoginSchema };

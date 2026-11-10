import { z } from "zod";

import { normalizeCpf } from "@/modules/user/services/driver-cpf";

/**
 * A driver's CPF on the record, shared by create and update and mirrored by
 * the web form (src/schemas/cpf-field): the login's rule (driver-cpf.ts),
 * check digits included. Only the length was checked before, so a mistyped
 * CPF was stored without a word, and that driver could never sign in by CPF:
 * the app and the login refuse it before any record is read.
 *
 * Masked or not; stored as the 11 digits. One message at a time, the web's
 * wording, so a refusal reads the same on the screen and in the API's 400.
 * The login's field (driver-access-schema) says "required" and "invalid"
 * with these same constants, so the two never drift apart.
 */
const CPF_MESSAGES = {
  required: "O CPF é obrigatório.",
  length: "O CPF deve ter exatamente 11 dígitos.",
  invalid: "O CPF informado não é válido.",
} as const;

/** Why a CPF that normalizeCpf refused cannot be saved. */
function cpfRefusal(value: string): string {
  if (value.replace(/[\s.\-]/g, "") === "") return CPF_MESSAGES.required;

  // Only the mask around too few or too many digits: say how many it takes.
  // Any other character is not a CPF at all.
  if (/^[\d.\-\s]+$/.test(value) && value.replace(/\D/g, "").length !== 11) {
    return CPF_MESSAGES.length;
  }

  return CPF_MESSAGES.invalid;
}

const driverRecordCpfField = z
  .string({ message: CPF_MESSAGES.required })
  .transform((value, ctx) => {
    const cpf = normalizeCpf(value);

    if (!cpf) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: cpfRefusal(value) });

      return z.NEVER;
    }

    return cpf;
  })
  .describe(
    "CPF do motorista, com ou sem máscara (000.000.000-00). Os dígitos verificadores são conferidos, e uma sequência repetida é recusada. Gravado só com os 11 dígitos.",
  );

export { CPF_MESSAGES, driverRecordCpfField };

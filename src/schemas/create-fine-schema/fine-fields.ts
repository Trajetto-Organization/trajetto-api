import { z } from "zod";

import { optionalMultilineText } from "@/shared/delivery/text-rules";
import { dateOnlyFromKey } from "@/shared/time/business-day";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isValidDateString,
} from "@/shared/utils/zod-schema-helpers";

/**
 * The fields the fine create and edit share, written once.
 *
 * Location and observation used to accept only letters, digits, spaces and
 * hyphens, so "Av. Brasil, 1000" — the address as the notice prints it — was
 * refused, and so was a period at the end of an observation. They now follow
 * the product's text rules: no blank value, no space at the ends, no
 * repeated spaces; the observation is multiline (decision 5.5).
 *
 * "Not in the future" is not checked here: it is a business-day rule and
 * needs the company's zone (see modules/fine/usecases/fine-dates.ts), which
 * also turns a day into the instant stored.
 * Mirrored by the web's features/fine/lib/fine-form-schema.ts.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A day ("YYYY-MM-DD", what the form sends) or, from older clients, an ISO
 * instant. A day must exist: `new Date("2026-02-30")` rolls over to March
 * and used to pass.
 */
function isFineDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return isValidDateString(value);

  try {
    dateOnlyFromKey(value);
    return true;
  } catch {
    return false;
  }
}

const DATE_DESCRIPTION =
  "AAAA-MM-DD: o dia, no fuso da empresa (um instante ISO de clientes antigos também é aceito).";

function dateField(label: string) {
  return z
    .string({ required_error: `A ${label} é obrigatória.` })
    .min(1, `A ${label} é obrigatória.`)
    .refine(isFineDate, `A ${label} é inválida.`)
    .describe(`${label[0].toUpperCase()}${label.slice(1)}. ${DATE_DESCRIPTION}`);
}

const paymentDateField = z.preprocess(
  (val) => (typeof val === "string" && val.trim() === "" ? null : val),
  z
    .string()
    .refine(isFineDate, "A data de pagamento é inválida.")
    .nullable()
    .optional()
    .describe(`Data de pagamento; vazio desfaz o pagamento. ${DATE_DESCRIPTION}`),
);

const amountField = z.preprocess(
  (val) => {
    if (typeof val === "string") {
      const cleaned = val.replace(/[^\d,.]/g, "");

      if (cleaned === "" || cleaned === "," || cleaned === ".") {
        return undefined;
      }

      // A comma means the Brazilian format ("1.234,56": dots are
      // thousands); without one the dot is the decimal point. Dropping
      // every dot turned "293.47" into 29347.
      const normalized = cleaned.includes(",")
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned;

      return parseFloat(normalized);
    }

    return val;
  },
  z
    .number({
      required_error: "O valor da multa é obrigatório.",
      invalid_type_error: "O valor da multa deve ser um número válido.",
    })
    .positive("O valor da multa deve ser maior que zero.")
    .max(999999.99, "O valor da multa não pode exceder R$ 999.999,99."),
);

const pointsField = z.preprocess(
  (val) => {
    if (typeof val === "string") {
      if (val.trim() === "") return undefined;

      const parsed = Number(val);
      return Number.isNaN(parsed) ? val : parsed;
    }

    return val;
  },
  z
    .number({
      required_error: "A pontuação é obrigatória.",
      invalid_type_error: "A pontuação deve ser um número válido.",
    })
    .int("A pontuação deve ser um número inteiro.")
    // Zero is real: some infractions put no points on the licence.
    .min(0, "A pontuação não pode ser negativa.")
    .max(20, "A pontuação não pode exceder 20 pontos."),
);

const locationField = z.preprocess(
  (val) => (val === "" ? null : val),
  z
    .string()
    .max(200, "O local da infração deve ter no máximo 200 caracteres.")
    .superRefine((value, ctx) => {
      if (value.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O local da infração não pode conter apenas espaços.",
        });

        return;
      }

      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O local da infração não deve conter espaços consecutivos.",
        });

        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O local da infração não pode começar ou terminar com espaço em branco.",
        });
      }
    })
    .nullable()
    .optional(),
);

const observationField = optionalMultilineText("O campo Observações", 500);

/** "12.5", 12.5 or "" (none) → a number or null. */
function coordinateField(min: number, max: number, label: string) {
  return z.preprocess(
    (val) => {
      if (typeof val === "string") {
        if (val.trim() === "" || val === "null") return null;

        const parsed = parseFloat(val);
        return Number.isNaN(parsed) ? val : parsed;
      }

      return val;
    },
    z
      .number({ invalid_type_error: `A ${label} deve ser um número válido.` })
      .min(min, `A ${label} deve estar entre ${min} e ${max}.`)
      .max(max, `A ${label} deve estar entre ${min} e ${max}.`)
      .nullable()
      .optional(),
  );
}

export {
  amountField,
  coordinateField,
  dateField,
  locationField,
  observationField,
  paymentDateField,
  pointsField,
};

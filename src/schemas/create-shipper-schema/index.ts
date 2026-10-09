import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";
import { isValidCnpj } from "@/shared/delivery/cnpj";

const shipperNameSchema = z
  .string()
  .min(2, "O nome do embarcador deve ter no mínimo 2 caracteres.")
  .max(150, "O nome do embarcador deve ter no máximo 150 caracteres.")
  .superRefine((value, ctx) => {
    if (isEmptyOrWhitespace(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome do embarcador não pode conter apenas espaços.",
      });

      return;
    }

    if (hasConsecutiveSpaces(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome do embarcador não deve conter espaços consecutivos.",
      });

      return;
    }

    if (hasSpaceAtEdges(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "O nome do embarcador não pode começar ou terminar com espaço em branco.",
      });
    }
  });

const shipperCnpjSchema = z.preprocess(
  (val) => {
    if (typeof val === "string") {
      const digits = val.replace(/\D/g, "");
      return digits === "" ? null : digits;
    }

    return val;
  },
  z
    .string()
    .length(14, "O CNPJ deve ter exatamente 14 dígitos.")
    .regex(/^\d{14}$/, "O CNPJ deve conter apenas números.")
    // The check digits (decision 5.7): the NF-e import matches issuers by
    // this CNPJ, so a typo would block the real one or duplicate the shipper.
    .refine(isValidCnpj, "O CNPJ informado não é válido.")
    .nullable()
    .optional(),
);

const shipperTelephoneSchema = z.preprocess(
  (val) => {
    if (typeof val === "string") {
      const digits = val.replace(/\D/g, "");
      return digits === "" ? null : digits;
    }

    return val;
  },
  z
    .string()
    .regex(
      /^\d{10,11}$/,
      "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
    )
    .nullable()
    .optional(),
);

const shipperEmailSchema = z.preprocess(
  (val) => (val === "" ? null : val),
  z
    .string()
    .email("O e-mail informado não é válido.")
    .max(100, "O e-mail deve ter no máximo 100 caracteres.")
    .nullable()
    .optional(),
);

/**
 * "Razão social" (decision 14.8): printed on the proof document as the
 * issuer's legal name. Optional; an empty field means none, and the PDF then
 * prints the shipper's name.
 */
const shipperCorporateReasonSchema = z.preprocess(
  (val) => {
    if (typeof val !== "string") return val;

    const trimmed = val.trim();

    return trimmed === "" ? null : trimmed;
  },
  z
    .string()
    .max(150, "A razão social deve ter no máximo 150 caracteres.")
    .nullable()
    .optional()
    .describe("Razão social do embarcador, impressa no comprovante. Opcional."),
);

const createShipperSchema = z.object({
  name: shipperNameSchema,
  corporate_reason: shipperCorporateReasonSchema,
  cnpj: shipperCnpjSchema,
  email: shipperEmailSchema,
  telephone: shipperTelephoneSchema,
});

export {
  createShipperSchema,
  shipperCorporateReasonSchema,
  shipperNameSchema,
  shipperCnpjSchema,
  shipperEmailSchema,
  shipperTelephoneSchema,
};

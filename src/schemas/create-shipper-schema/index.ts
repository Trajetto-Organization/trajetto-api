import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";

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

const createShipperSchema = z.object({
  name: shipperNameSchema,
  cnpj: shipperCnpjSchema,
  email: shipperEmailSchema,
  telephone: shipperTelephoneSchema,
});

export {
  createShipperSchema,
  shipperNameSchema,
  shipperCnpjSchema,
  shipperEmailSchema,
  shipperTelephoneSchema,
};

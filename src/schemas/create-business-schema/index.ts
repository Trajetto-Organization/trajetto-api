import { z } from "zod";

import { businessTimezoneField } from "@/schemas/business-timezone-schema";
import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";

const createBusinessSchema = z.object({
  cep: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        // Remove all non-numeric characters
        return val.replace(/\D/g, "");
      }

      return val;
    },
    z
      .string()
      .length(8, "O CEP deve ter exatamente 8 dígitos.")
      .regex(/^\d{8}$/, "O CEP deve conter apenas números."),
  ),
  city: z
    .string()
    .min(2, "A cidade deve ter no mínimo 2 caracteres.")
    .max(100, "A cidade deve ter no máximo 100 caracteres.")
    .superRefine((value, ctx) => {
      if (isEmptyOrWhitespace(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome da cidade não pode ser vazio ou conter apenas espaços.",
        });

        return;
      }

      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O nome da cidade não deve conter espaços consecutivos.",
        });

        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome da cidade não pode começar ou terminar com espaço em branco.",
        });

        return;
      }

      if (!/^[\p{L}0-9]+(?:[ \-][\p{L}0-9]+)*$/u.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome da cidade deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.",
        });
      }
    }),
  uf: z
    .string()
    .length(2, "UF deve ter exatamente 2 caracteres.")
    .toUpperCase()
    .superRefine((value, ctx) => {
      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O UF não deve conter espaços consecutivos.",
        });

        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O UF não pode começar ou terminar com espaço em branco.",
        });

        return;
      }

      if (/[^A-Z]/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O UF deve conter apenas letras sem números, símbolos ou traços.",
        });
        return;
      }
    }),
  street: z
    .string()
    .min(3, "O nome da rua deve ter no mínimo 3 caracteres.")
    .max(100, "O nome da rua deve ter no máximo 100 caracteres.")
    .superRefine((value, ctx) => {
      if (isEmptyOrWhitespace(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O nome da rua não pode ser vazio ou conter apenas espaços.",
        });

        return;
      }

      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O nome da rua não deve conter espaços consecutivos.",
        });

        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome da rua não pode começar ou terminar com espaço em branco.",
        });

        return;
      }

      if (!/^[\p{L}0-9]+(?:[ \-][\p{L}0-9]+)*$/u.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome da rua deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.",
        });
      }
    }),
  address_number: z
    .string()
    .min(1, "O número do endereço é obrigatório.")
    .max(10, "O número do endereço deve ter no máximo 10 caracteres.")
    .regex(
      /^\d+[A-Za-z]?$/,
      "O número do endereço deve conter apenas números e letras.",
    )
    .superRefine((value, ctx) => {
      if (isEmptyOrWhitespace(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O número do endereço não pode ser vazio ou conter apenas espaços.",
        });

        return;
      }

      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O número do endereço não deve conter espaços consecutivos.",
        });

        return;
      }
    }),
  cnpj: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        return val.replace(/\D/g, "");
      }

      return val;
    },
    z
      .string()
      .length(14, "O CNPJ deve ter exatamente 14 dígitos.")
      .regex(/^\d{14}$/, "O CNPJ deve conter apenas números."),
  ),
  complement: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .max(50, "O complemento deve ter no máximo 50 caracteres.")
      .superRefine((value, ctx) => {
        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome do complemento não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome do complemento não pode começar ou terminar com espaço em branco.",
          });

          return;
        }

        if (!/^[\p{L}0-9]+(?:[ \-][\p{L}0-9]+)*$/u.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome do complemento deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.",
          });
        }
      })
      .optional()
      .nullable(),
  ),
  cnae: z
    .string()
    .length(7, "O CNAE deve ter exatamente 7 dígitos numéricos.")
    .regex(/^\d{7}$/, "O CNAE deve conter apenas números."),
  corporate_reason: z
    .string()
    .min(1, "A razão social é obrigatória.")
    .max(150, "A razão social deve ter no máximo 150 caracteres.")
    .superRefine((value, ctx) => {
      if (isEmptyOrWhitespace(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome da razão social não pode ser vazio ou conter apenas espaços.",
        });
        return;
      }

      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome da razão social não deve conter espaços consecutivos.",
        });

        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "A razão social não pode começar ou terminar com espaço em branco.",
        });

        return;
      }

      if (!/^[\p{L}0-9]+(?:[ \-][\p{L}0-9]+)*$/u.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O razão social deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.",
        });
      }
    }),
  email: z
    .string()
    .min(1, "O e-mail é obrigatório.")
    .email("O e-mail informado não é válido.")
    .max(100, "O e-mail deve ter no máximo 100 caracteres."),
  responsible_name: z.string().superRefine((value, ctx) => {
    if (value.length > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome não deve exceder 100 caracteres.",
      });
      return;
    }

    if (hasConsecutiveSpaces(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome não deve conter espaços consecutivos.",
      });
      return;
    }

    if (hasSpaceAtEdges(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome não pode começar ou terminar com espaço em branco.",
      });
      return;
    }

    if (!/^\S+ \S+(?: \S+)*$/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Por favor, insira o nome completo.",
      });
      return;
    }

    const regex = /^(?=[\p{L}\p{N}])[ \p{L}\p{N}\p{P}]*(?<=[\p{L}\p{N}])$/u;
    if (!regex.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
      });
    }
  }),
  telephone: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        return val.replace(/\D/g, "");
      }

      return val;
    },
    z
      .string()
      .regex(
        /^\d{10,11}$/,
        "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
      ),
  ),
  erp_code: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .max(50, "O código ERP deve ter no máximo 50 caracteres.")
      .superRefine((value, ctx) => {
        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "O código ERP não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O código ERP não pode começar ou terminar com espaço em branco.",
          });

          return;
        }

        if (!/^[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)*$/.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O código ERP deve conter apenas letras, números, traços ou underscores, e não pode começar com um símbolo ou ter um símbolo seguido de número.",
          });
        }
      })
      .optional()
      .nullable(),
  ),
  fantasy_name: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .max(100, "O nome fantasia deve ter no máximo 100 caracteres.")
      .superRefine((value, ctx) => {
        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "O nome fantasia não deve conter espaços consecutivos.",
          });
          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome fantasia não pode começar ou terminar com espaço em branco.",
          });
          return;
        }

        if (
          !/^[\p{L}\p{N}](?!.*[_@-]$)[\p{L}\p{N}\p{P} ]{0,98}[\p{L}\p{N}]$/u.test(
            value,
          )
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome fantasia deve começar e terminar com letra ou número, ter de 2 a 100 caracteres, " +
              "permitir letras (inclusive acentos), números, espaços e símbolos de pontuação, " +
              "mas não pode incluir '_' '@' ou '-' nas extremidades.",
          });
        }
      })
      .optional()
      .nullable(),
  ),
  timezone: businessTimezoneField.optional(),
});

export { createBusinessSchema };

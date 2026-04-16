import { z } from "zod";
import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
  isValidDateString,
} from "@/shared/utils/zod-schema-helpers";

const isAdult = (date: Date) => {
  const today = new Date();
  const birthDate = new Date(date);

  const age = today.getFullYear() - birthDate.getFullYear();
  const monthDifference = today.getMonth() - birthDate.getMonth();

  // If you haven't had a birthday this year, deduct 1 from your age.
  if (
    monthDifference < 0 ||
    (monthDifference === 0 && today.getDate() < birthDate.getDate())
  ) {
    return age - 1 >= 18;
  }

  return age >= 18;
};

const createDriverSchema = z.object({
  name: z
    .string()
    .min(3, "O nome deve ter no mínimo 3 caracteres.")
    .max(100, "O nome deve ter no máximo 100 caracteres.")
    .superRefine((value, ctx) => {
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
  birth_date: z
    .string()
    .min(1, "A data de nascimento é obrigatória.")
    .superRefine((val, ctx) => {
      if (!isValidDateString(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Data de nascimento inválida.",
        });

        return;
      }

      const date = new Date(val);

      if (!isAdult(date)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O motorista deve ter pelo menos 18 anos.",
        });
      }
    }),
  cnh: z
    .string()
    .min(1, "O número da CNH é obrigatório.")
    .max(20, "O número da CNH deve ter no máximo 20 caracteres."),
  cpf: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        return val.replace(/\D/g, "");
      }

      return val;
    },
    z
      .string()
      .length(11, "O CPF deve ter exatamente 11 dígitos.")
      .regex(/^\d{11}$/, "O CPF deve conter apenas números."),
  ),
  rg: z
    .string()
    .min(1, "O número do RG é obrigatório.")
    .max(20, "O número do RG deve ter no máximo 20 caracteres."),
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
    ),
  complement: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .max(50, "O complemento deve ter no máximo 50 caracteres.")
      .superRefine((value, ctx) => {
        if (value === undefined || value === "") {
          return;
        }

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
      .nullable()
      .optional(),
  ),
  status: z.enum(["ACTIVE", "INACTIVE"], {
    errorMap: () => ({
      message: "O status deve ser 'ACTIVE' ou 'INACTIVE'",
    }),
  }),
  contract_type: z.enum(["OWNED", "THIRD_PARTY"], {
    errorMap: () => ({
      message: "O tipo de contrato deve ser 'OWNED' ou 'THIRD_PARTY'",
    }),
  }),
  branchId: z.preprocess(
    emptyStringToNull,
    z.string().uuid("ID da filial é inválido.").nullable().optional(),
  ),
});

export { createDriverSchema };

import { z } from "zod";

const hasSpaceAtEdges = (value: string) => /^\s|\s$/.test(value);
const isEmptyOrWhitespace = (value: string): boolean =>
  value.trim().length === 0;
const hasConsecutiveSpaces = (value: string): boolean => /\s{2,}/.test(value);

// Helper function to convert empty strings to null
const emptyStringToNull = (value: any) => {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  return value;
};

const createSupplierSchema = z.object({
  name: z
    .string()
    .min(2, "O nome do fornecedor deve ter no mínimo 2 caracteres.")
    .max(100, "O nome do fornecedor deve ter no máximo 100 caracteres.")
    .superRefine((value, ctx) => {
      if (value.length > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O nome do fornecedor não deve exceder 100 caracteres.",
        });
        return;
      }

      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O nome do fornecedor não deve conter espaços consecutivos.",
        });
        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome do fornecedor não pode começar ou terminar com espaço em branco.",
        });
        return;
      }

      if (!/^\S+ \S+(?: \S+)*$/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Por favor, insira o nome do fornecedor completo.",
        });
        return;
      }

      const regex = /^(?=[\p{L}\p{N}])[ \p{L}\p{N}\p{P}]*(?<=[\p{L}\p{N}])$/u;
      if (!regex.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome do fornecedor deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
        });
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
  cep: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        val = val.replace(/\D/g, "");
      }
      return emptyStringToNull(val);
    },
    z
      .string()
      .length(8, "O CEP deve ter exatamente 8 dígitos.")
      .regex(/^\d{8}$/, "O CEP deve conter apenas números.")
      .nullable()
      .optional()
      .or(z.literal("")),
  ),
  city: z.preprocess(
    emptyStringToNull,
    z
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
      })
      .nullable()
      .optional()
      .or(z.literal("")),
  ),
  uf: z.preprocess(
    emptyStringToNull,
    z
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
      })
      .nullable()
      .optional()
      .or(z.literal("")),
  ),
  street: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .min(3, "O nome da rua deve ter no mínimo 3 caracteres.")
      .max(100, "O nome da rua deve ter no máximo 100 caracteres.")
      .superRefine((value, ctx) => {
        if (isEmptyOrWhitespace(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome da rua não pode ser vazio ou conter apenas espaços.",
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
      })
      .nullable()
      .optional()
      .or(z.literal("")),
  ),
  address_number: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .min(1, "O número do endereço é obrigatório.")
      .max(10, "O número do endereço deve ter no máximo 10 caracteres.")
      .regex(
        /^\d+[A-Za-z]?$/,
        "O número do endereço deve conter apenas números e letras.",
      )
      .superRefine((value, ctx) => {
        if (value && isEmptyOrWhitespace(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O número do endereço não pode ser vazio ou conter apenas espaços.",
          });
          return;
        }

        if (value && hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O número do endereço não deve conter espaços consecutivos.",
          });
          return;
        }
      })
      .nullable()
      .optional()
      .or(z.literal("")),
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
      .optional()
      .or(z.literal("")),
  ),
  telephone: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        val = val.replace(/\D/g, "");
      }
      return emptyStringToNull(val);
    },
    z
      .string()
      .regex(
        /^\d{10,11}$/,
        "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
      )
      .nullable()
      .optional()
      .or(z.literal("")),
  ),
  email: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .email("O e-mail informado não é válido.")
      .max(100, "O e-mail deve ter no máximo 100 caracteres.")
      .nullable()
      .optional()
      .or(z.literal("")),
  ),
});

export { createSupplierSchema };

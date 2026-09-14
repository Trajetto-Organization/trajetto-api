import { z } from "zod";
import { AccountPayableCategory } from "@prisma/client";

import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isValidDateString,
} from "@/shared/utils/zod-schema-helpers";

const updateAccountPayableSchema = z
  .object({
    category: z
      .nativeEnum(AccountPayableCategory, {
        errorMap: () => ({ message: "Categoria da conta inválida." }),
      })
      .optional()
      .describe(
        "Categoria/tipo da conta (FUEL, MAINTENANCE, INSURANCE, TAXES_FEES, FINES, TOLLS, RENTAL, PAYROLL, OTHER). Com OTHER, category_description é obrigatória.",
      ),
    category_description: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .max(
          120,
          "A descrição da categoria deve ter no máximo 120 caracteres.",
        )
        .superRefine((value, ctx) => {
          if (hasConsecutiveSpaces(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "A descrição da categoria não deve conter espaços consecutivos.",
            });

            return;
          }

          if (hasSpaceAtEdges(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "A descrição da categoria não pode começar ou terminar com espaço em branco.",
            });
          }
        })
        .optional()
        .nullable()
        .describe("Descrição livre da categoria — usada quando category = OTHER."),
    ),
    due_date: z
      .string()
      .min(1, "Data de vencimento é obrigatória.")
      .superRefine((val, ctx) => {
        if (!isValidDateString(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Data de vencimento inválida",
          });

          return;
        }
      })
      .optional(),
    payment_date: z
      .preprocess(
        emptyStringToNull,
        z
          .string()
          .transform((val) => (val && val.trim() !== "" ? val : null))
          .nullable()
          .optional()
          .refine(
            (val) => !val || isValidDateString(val),
            "Data de pagamento inválida",
          ),
      )
      .optional(),
    amount: z
      .number()
      .positive("O valor deve ser um valor positivo.")
      .min(1, "O valor deve ser no mínimo R$ 1,00")
      .max(9999999.99, "O valor não pode exceder R$ 9.999.999,99.")
      .optional(),
    amount_paid: z.preprocess((val) => {
      // If it is an empty string, convert it to null
      if (typeof val === "string" && val.trim() === "") {
        return null;
      }

      // If it is null or undefined, keep
      if (val === null || val === undefined) {
        return val;
      }

      // If it is a number, it returns
      if (typeof val === "number") {
        return val;
      }

      // If it is a string with value, try to convert it
      if (typeof val === "string") {
        const parsed = parseFloat(val);
        return isNaN(parsed) ? null : parsed;
      }

      return val;
    }, z.number().nonnegative("O valor pago deve ser um valor não negativo.").min(1, "O valor pago deve ser no mínimo R$ 1,00").max(9999999.99, "O valor pago não pode exceder R$ 9.999.999,99.").optional().nullable()),
    branchId: z.preprocess(
      emptyStringToNull,
      z.string().uuid("ID da filial é inválido.").optional().nullable(),
    ),
    serviceOrderId: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .uuid("ID da ordem de serviço é inválido.")
        .optional()
        .nullable(),
    ),
    registrationUserId: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .uuid("ID do usuário responsável é inválido.")
        .optional()
        .nullable(),
    ),
  })
  .refine(
    (data) => {
      // If there is a payment date, there must be a paid amount.
      if (data.payment_date && !data.amount_paid) {
        return false;
      }

      // If there is a paid amount, there must be a payment date.
      if (data.amount_paid && !data.payment_date) {
        return false;
      }

      // Amount paid cannot be greater than the total amount
      if (data.amount_paid && data.amount_paid > (data.amount as number)) {
        return false;
      }

      return true;
    },
    {
      message:
        "Se há data de pagamento, deve haver valor pago e vice-versa. O valor pago não pode ser maior que o valor total.",
      path: ["amount_paid"],
    },
  )
  .refine(
    (data) =>
      data.category === undefined ||
      data.category !== "OTHER" ||
      Boolean(data.category_description),
    {
      message: "Descreva a categoria ao selecionar \"Outros\".",
      path: ["category_description"],
    },
  )
  // A description for a named category is stale text waiting to mislead.
  .transform((data) =>
    data.category === undefined || data.category === "OTHER"
      ? data
      : { ...data, category_description: null },
  );

export { updateAccountPayableSchema };

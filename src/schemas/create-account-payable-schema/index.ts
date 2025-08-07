import { z } from "zod";

// Helper function to convert empty strings to null
const emptyStringToNull = (value: any) => {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  return value;
};

const isValidDateString = (value: string): boolean => {
  const date = new Date(value);
  return !isNaN(date.getTime());
};

const createAccountPayableSchema = z
  .object({
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
      }),
    payment_date: z.preprocess(
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
    ),
    amount: z
      .number()
      .positive("O valor deve ser um valor positivo.")
      .min(1, "O valor deve ser no mínimo R$ 1,00")
      .max(9999999.99, "O valor não pode exceder R$ 9.999.999,99."),
    amount_paid: z
      .number()
      .nonnegative("O valor pago deve ser um valor não negativo.")
      .min(1, "O valor pago deve ser no mínimo R$ 1,00")
      .max(9999999.99, "O valor pago não pode exceder R$ 9.999.999,99.")
      .optional()
      .nullable(),
    branchId: z.string().uuid("O ID da filial deve ser um UUID válido."),
    serviceOrderId: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .uuid("O ID da ordem de serviço deve ser um UUID válido.")
        .optional()
        .nullable(),
    ),
    registrationUserId: z
      .string()
      .uuid("O ID do usuário responsável deve ser um UUID válido."),
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
      if (data.amount_paid && data.amount_paid > data.amount) {
        return false;
      }

      return true;
    },
    {
      message:
        "Se há data de pagamento, deve haver valor pago e vice-versa. O valor pago não pode ser maior que o valor total.",
      path: ["amount_paid"],
    },
  );

export { createAccountPayableSchema };

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

const createFineSchema = z.object({
  violation_date: z
    .string()
    .min(1, "Data da infração é obrigatória")
    .superRefine((val, ctx) => {
      if (!isValidDateString(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Data da infração inválida",
        });
        return;
      }

      const violationDate = new Date(val);
      const today = new Date();

      today.setHours(23, 59, 59, 999); // Set to end of day for comparison

      if (violationDate > today) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A data da infração não pode ser futura",
        });
      }
    }),
  due_date: z
    .string()
    .min(1, "Data de vencimento é obrigatória")
    .superRefine((val, ctx) => {
      if (!isValidDateString(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Data de vencimento inválida",
        });
      }
    }),
  payment_date: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .superRefine((val, ctx) => {
        if (val && !isValidDateString(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Data de pagamento inválida",
          });
        }
      })
      .nullable()
      .optional(),
  ),
  amount: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        const cleaned = val.replace(/[^\d,.]/g, "");

        if (cleaned === "" || cleaned === "," || cleaned === ".") {
          return undefined;
        }

        const normalized = cleaned.replace(/\./g, "").replace(",", ".");
        return parseFloat(normalized);
      }
      return val;
    },
    z
      .number({
        required_error: "O valor da multa é obrigatório",
        invalid_type_error: "O valor da multa deve ser um número válido",
      })
      .positive("O valor da multa deve ser maior que zero"),
  ),
  points: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        if (val.trim() === "") {
          return undefined;
        }
        const parsed = parseInt(val, 10);
        return isNaN(parsed) ? undefined : parsed;
      }
      return val;
    },
    z
      .number({
        required_error: "A pontuação é obrigatória",
        invalid_type_error: "A pontuação deve ser um número válido",
      })
      .min(0, "A pontuação não pode ser negativa")
      .max(20, "A pontuação não pode exceder 20 pontos"),
  ),
  location: z.string().optional().nullable(),
  observation: z.string().optional().nullable(),
  branchId: z.string().uuid("ID da filial deve ser um UUID válido"),
  driverId: z.string().uuid("ID do motorista deve ser um UUID válido"),
  vehicleId: z.string().uuid("ID do veículo deve ser um UUID válido"),
  trafficViolationCodeId: z
    .string()
    .uuid("ID do código de infração deve ser um UUID válido"),
});

export { createFineSchema };

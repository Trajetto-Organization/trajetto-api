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

const updateFineSchema = z.object({
  violation_date: z
    .string()
    .superRefine((val, ctx) => {
      if (val && !isValidDateString(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Data da infração deve ser uma data válida",
        });
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
    })
    .optional(),
  due_date: z
    .string()
    .min(1, "Data de vencimento é obrigatória")
    .superRefine((val, ctx) => {
      if (val && !isValidDateString(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Data de vencimento deve ser uma data válida",
        });
      }
    })
    .optional(),
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
      // Converter string para number
      if (typeof val === "string") {
        const cleaned = val.replace(/[^\d,.]/g, "");
        if (cleaned === "" || cleaned === "," || cleaned === ".") {
          return undefined;
        }
        // Converter formato brasileiro para americano
        const normalized = cleaned.replace(/\./g, "").replace(",", ".");
        return parseFloat(normalized);
      }
      return val;
    },
    z
      .number({
        invalid_type_error: "O valor da multa deve ser um número válido",
      })
      .positive("O valor da multa deve ser maior que zero")
      .optional(),
  ),
  points: z.preprocess(
    (val) => {
      // Converter string para number, incluindo strings vazias
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
        invalid_type_error: "A pontuação deve ser um número válido",
      })
      .min(0, "A pontuação não pode ser negativa")
      .max(20, "A pontuação não pode exceder 20 pontos")
      .optional(),
  ),
  location: z.string().optional().nullable(),
  observation: z.string().optional().nullable(),
  branchId: z.string().uuid("ID da filial deve ser um UUID válido").optional(),
  driverId: z
    .string()
    .uuid("ID do motorista deve ser um UUID válido")
    .optional(),
  vehicleId: z
    .string()
    .uuid("ID do veículo deve ser um UUID válido")
    .optional(),
  trafficViolationCodeId: z
    .string()
    .uuid("ID do código de infração deve ser um UUID válido")
    .optional(),
});

export { updateFineSchema };

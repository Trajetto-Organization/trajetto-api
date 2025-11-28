import { z } from "zod";

import { LocationSource } from "@prisma/client";
import { isWithinAllowedDistance } from "@/shared/utils/geolocation";

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

const updateFineSchema = z
  .object({
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
    branchId: z
      .string()
      .uuid("ID da filial deve ser um UUID válido")
      .optional(),
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

    // 📍 GEOLOCATION: Final location (edited or original)
    latitude: z.preprocess(
      (val) => {
        if (typeof val === "string") {
          if (val.trim() === "" || val === "null") return null;
          const parsed = parseFloat(val);
          return isNaN(parsed) ? undefined : parsed;
        }
        return val;
      },
      z
        .number({
          invalid_type_error: "A latitude deve ser um número válido.",
        })
        .min(-90, "A latitude deve estar entre -90 e 90.")
        .max(90, "A latitude deve estar entre -90 e 90.")
        .optional()
        .nullable(),
    ),

    longitude: z.preprocess(
      (val) => {
        if (typeof val === "string") {
          if (val.trim() === "" || val === "null") return null;
          const parsed = parseFloat(val);
          return isNaN(parsed) ? undefined : parsed;
        }
        return val;
      },
      z
        .number({
          invalid_type_error: "A longitude deve ser um número válido.",
        })
        .min(-180, "A longitude deve estar entre -180 e 180.")
        .max(180, "A longitude deve estar entre -180 e 180.")
        .optional()
        .nullable(),
    ),

    // 📍 GEOLOCATION: Original GPS location (before any manual editing)
    latitude_original: z
      .number()
      .min(-90, "A latitude original deve estar entre -90 e 90.")
      .max(90, "A latitude original deve estar entre -90 e 90.")
      .optional()
      .nullable(),

    longitude_original: z
      .number()
      .min(-180, "A longitude original deve estar entre -180 e 180.")
      .max(180, "A longitude original deve estar entre -180 e 180.")
      .optional()
      .nullable(),

    // 🆕 GEOLOCATION AUDIT: Track location source
    location_source: z.nativeEnum(LocationSource).optional().nullable(),

    // 🆕 AUDIT FIELDS: Who and when edited location
    location_edited_by: z.string().uuid().optional().nullable(),
    location_edited_at: z.string().datetime().optional().nullable(),
  })
  // 🆕 VALIDATION: Distance check for GPS_MANUAL (manual adjustment)
  .refine(
    (data) => {
      // If location source is GPS_MANUAL, validate distance
      if (
        data.location_source === LocationSource.GPS_MANUAL &&
        data.latitude &&
        data.longitude &&
        data.latitude_original &&
        data.longitude_original
      ) {
        return isWithinAllowedDistance(
          data.latitude_original,
          data.longitude_original,
          data.latitude,
          data.longitude,
          500, // 500 meters maximum allowed distance
        );
      }

      // For other cases, validation passes
      return true;
    },
    {
      message:
        "A localização editada está muito distante da localização capturada pelo GPS (máximo 500m permitido). Possível inconsistência detectada.",
      path: ["latitude"], // Field where error appears
    },
  );

export { updateFineSchema };

import { z } from "zod";

import { LocationSource, RecordOrigin } from "@prisma/client";
import { isWithinAllowedDistance } from "@/shared/utils/geolocation";

import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isValidDateString,
} from "@/shared/utils/zod-schema-helpers";

const createFineSchema = z
  .object({
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
        .min(1, "A pontuação não pode ser negativa")
        .max(20, "A pontuação não pode exceder 20 pontos"),
    ),
    location: z
      .string()
      .max(200, "Local da infração deve ter no máximo 200 caracteres")
      .optional()
      .superRefine((value, ctx) => {
        if (value === undefined || value === "") {
          return;
        }

        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome do local da infração não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome do local da infração não pode começar ou terminar com espaço em branco.",
          });

          return;
        }

        if (!/^[\p{L}0-9]+(?:[ \-][\p{L}0-9]+)*$/u.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome do local da infração deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.",
          });
        }
      }),
    observation: z
      .string()
      .max(500, "Observações devem ter no máximo 500 caracteres")
      .optional()
      .superRefine((value, ctx) => {
        if (value === undefined || value === "") {
          return;
        }

        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome da observação não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome da observação não pode começar ou terminar com espaço em branco.",
          });

          return;
        }

        if (!/^[\p{L}0-9]+(?:[ \-][\p{L}0-9]+)*$/u.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome da observação deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.",
          });
        }
      }),
    branchId: z.string().uuid("ID da filial deve ser um UUID válido"),
    driverId: z.string().uuid("ID do motorista deve ser um UUID válido"),
    vehicleId: z.string().uuid("ID do veículo deve ser um UUID válido"),
    trafficViolationCodeId: z
      .string()
      .uuid("ID do código de infração deve ser um UUID válido"),

    // 📍 GEOLOCATION: Final location (edited or original)
    latitude: z.preprocess(
      (val) => {
        if (typeof val === "string") {
          if (val.trim() === "") return null;

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
          if (val.trim() === "") return null;

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
    latitude_original: z.preprocess((val) => {
      if (typeof val === "string") {
        if (val.trim() === "") return null;

        const parsed = parseFloat(val);
        return isNaN(parsed) ? undefined : parsed;
      }

      return val;
    }, z.number().min(-90, "A latitude original deve estar entre -90 e 90.").max(90, "A latitude original deve estar entre -90 e 90.").optional().nullable()),

    longitude_original: z.preprocess((val) => {
      if (typeof val === "string") {
        if (val.trim() === "") return null;

        const parsed = parseFloat(val);
        return isNaN(parsed) ? undefined : parsed;
      }

      return val;
    }, z.number().min(-180, "A longitude original deve estar entre -180 e 180.").max(180, "A longitude original deve estar entre -180 e 180.").optional().nullable()),

    // 🆕 GEOLOCATION AUDIT: Track location source
    location_source: z.nativeEnum(LocationSource).optional().nullable(),

    // 🆕 RECORD ORIGIN: Track where the record was created
    created_from: z.nativeEnum(RecordOrigin, {
      errorMap: () => ({
        message: "Origem inválida. Deve ser MOBILE_APP ou WEB_DASHBOARD.",
      }),
    }),
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
        "A localização editada está muito distante da localização capturada pelo GPS (máximo 500m permitido).",
      path: ["latitude"],
    },
  );

export { createFineSchema };

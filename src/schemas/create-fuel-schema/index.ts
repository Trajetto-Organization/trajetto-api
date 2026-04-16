import { z } from "zod";
import { MultipartFile } from "@fastify/multipart";

import { LocationSource, RecordOrigin } from "@prisma/client";
import { isWithinAllowedDistance } from "@/shared/utils/geolocation";

import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
  isValidDateString,
} from "@/shared/utils/zod-schema-helpers";

const createFuelSchema = z
  .object({
    current_mileage: z.preprocess(
      (val) => {
        if (typeof val === "string") {
          if (val.trim() === "") return undefined;

          const cleanedValue = val.replace(/\./g, "").replace(",", ".");
          return parseFloat(cleanedValue);
        }

        return val;
      },
      z
        .number({
          required_error: "A quilometragem atual do veículo é obrigatória.",
          invalid_type_error:
            "A quilometragem atual deve ser um número válido.",
        })
        .nonnegative("A quilometragem atual deve ser um valor não negativo.")
        .min(0.1, "A quilometragem atual deve ser maior que zero.")
        .max(9999999, "A quilometragem atual não pode exceder 9.999.999 km."),
    ),
    liters_amount: z.preprocess(
      (val) => {
        if (typeof val === "string") {
          if (val.trim() === "") return undefined;
          return parseFloat(val.replace(",", "."));
        }

        return val;
      },
      z
        .number({
          required_error: "A quantidade de litros é obrigatória.",
          invalid_type_error:
            "A quantidade de litros deve ser um número válido.",
        })
        .positive("A quantidade de litros deve ser um valor positivo.")
        .min(0.001, "A quantidade de litros deve ser maior que zero.")
        .max(
          99999.999,
          "A quantidade de litros não pode exceder 99.999,999 L.",
        ),
    ),
    price_per_liter: z.preprocess(
      (val) => {
        if (typeof val === "string") {
          if (val.trim() === "") return undefined;
          return parseFloat(val.replace(",", "."));
        }

        return val;
      },
      z
        .number({
          required_error: "O preço por litro é obrigatório.",
          invalid_type_error: "O preço por litro deve ser um número válido.",
        })
        .positive("O preço por litro deve ser um valor positivo.")
        .min(0.01, "O preço por litro deve ser no mínimo R$ 0,01")
        .max(999.99, "O preço por litro não pode exceder R$ 999,99."),
    ),
    notes: z
      .string()
      .max(500, "As observações devem ter no máximo 500 caracteres.")
      .optional()
      .superRefine((value, ctx) => {
        if (value === undefined || value === "") {
          return;
        }

        if (isEmptyOrWhitespace(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "As observações não podem conter apenas espaços.",
          });

          return;
        }

        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "As observações não devem conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "As observações não podem começar ou terminar com espaço em branco.",
          });

          return;
        }
      }),
    refueling_date: z
      .string()
      .min(1, "A data do abastecimento é obrigatória.")
      .superRefine((val, ctx) => {
        if (!isValidDateString(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Data do abastecimento inválida.",
          });

          return;
        }

        // Validation: refueling date cannot be in the future
        const refuelingDate = new Date(val);
        const today = new Date();

        today.setHours(23, 59, 59, 999); // End of today

        if (refuelingDate > today) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A data do abastecimento não pode ser no futuro.",
          });

          return;
        }
      }),
    vehicleId: z
      .string({ required_error: "ID do veículo é obrigatório!" })
      .uuid("ID do veículo é inválido."),
    driverId: z.string().uuid("ID do motorista é inválido.").optional(),
    fuelTypeId: z
      .string({ required_error: "ID do tipo de combustível é obrigatório!" })
      .uuid("ID do tipo de combustível é inválido."),
    branchId: z.string().uuid("ID da filial é inválido.").optional(),

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
        "A localização editada está muito distante da localização capturada pelo GPS (máximo 500m permitido). Possível inconsistência detectada.",
      path: ["latitude"], // Field where error appears
    },
  );

// Schema for file validation
const odometerPhotoSchema = z
  .custom<MultipartFile>()
  .refine((file) => file !== undefined && file !== null, {
    message: "A foto do odômetro é obrigatória.",
  })
  .refine((file) => file?.mimetype?.startsWith("image/"), {
    message: "O arquivo deve ser uma imagem.",
  })
  .refine(
    (file) => {
      const allowedTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
      ];
      return allowedTypes.includes(file?.mimetype);
    },
    {
      message: "Tipo de arquivo não suportado. Use apenas JPEG, PNG ou WebP.",
    },
  );

// Combined schema for multipart request
const createFuelMultipartSchema = z.object({
  body: createFuelSchema,
  file: odometerPhotoSchema,
});

export { createFuelSchema, odometerPhotoSchema, createFuelMultipartSchema };

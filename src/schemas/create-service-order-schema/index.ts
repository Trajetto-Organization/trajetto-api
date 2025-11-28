import { z } from "zod";

import { LocationSource, RecordOrigin } from "@prisma/client";
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

const createServiceOrderSchema = z
  .object({
    date: z
      .string()
      .min(1, "Data da ordem de serviço é obrigatória.")
      .superRefine((val, ctx) => {
        if (!isValidDateString(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Data da ordem de serviço inválida",
          });

          return;
        }
      }),
    completion_date: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .transform((val) => (val && val.trim() !== "" ? val : null))
        .nullable()
        .optional()
        .refine(
          (val) => !val || isValidDateString(val),
          "Data de conclusão inválida",
        ),
    ),
    maintenance_type: z.enum(["INTERNAL", "EXTERNAL"], {
      errorMap: () => ({
        message: "Tipo de manutenção inválido. Deve ser INTERNAL ou EXTERNAL",
      }),
    }),
    total_amount: z
      .number()
      .nonnegative("O valor total deve ser um valor não negativo.")
      .min(1, "O valor total deve ser no mínimo R$ 1,00")
      .max(9999999.99, "O valor total não pode exceder R$ 9.999.999,99."),
    current_mileage_at_service: z.preprocess(
      (val) => {
        if (typeof val === "string") {
          if (val.trim() === "") return undefined;
          return parseFloat(val.replace(",", "."));
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
    maintenance_interval_km_at_service: z.preprocess(
      (val) => {
        if (typeof val === "string") {
          if (val.trim() === "") return undefined;
          return parseFloat(val.replace(",", "."));
        }
        return val;
      },
      z
        .number({
          required_error: "O intervalo de revisão em km é obrigatório.",
          invalid_type_error:
            "O intervalo de revisão em km deve ser um número válido.",
        })
        .min(0.1, "O intervalo de revisão em km deve ser maior que zero.")
        .positive("O intervalo de revisão em km deve ser um valor positivo.")
        .max(
          100000,
          "O intervalo de revisão em km não pode exceder 100.000 km.",
        ),
    ),
    last_maintenance_mileage_at_service: z.preprocess(
      (val) => {
        if (typeof val === "string") {
          if (val.trim() === "") return undefined;
          return parseFloat(val.replace(",", "."));
        }
        return val;
      },
      z
        .number({
          required_error: "A quilometragem da última revisão é obrigatória.",
          invalid_type_error:
            "A quilometragem da última revisão deve ser um número válido.",
        })
        .nonnegative(
          "A quilometragem da última revisão deve ser um valor não negativo.",
        )
        .min(0.1, "A quilometragem da última revisão deve ser maior que zero.")
        .max(
          9999999,
          "A quilometragem da última revisão não pode exceder 9.999.999 km.",
        ),
    ),
    new_mileage_after_service: z.preprocess(
      (val) => {
        if (typeof val === "string") {
          if (val.trim() === "") return undefined;
          return parseFloat(val.replace(",", "."));
        }
        return val;
      },
      z
        .number({
          invalid_type_error: "A nova quilometragem deve ser um número válido.",
        })
        .nonnegative("A nova quilometragem deve ser um valor não negativo.")
        .min(0.1, "A nova quilometragem deve ser maior que zero.")
        .max(9999999, "A nova quilometragem não pode exceder 9.999.999 km.")
        .optional()
        .nullable(),
    ),
    vehicleId: z.string().uuid("O ID do veículo deve ser um UUID válido."),
    responsibleUserId: z
      .string()
      .uuid("O ID do usuário responsável deve ser um UUID válido."),
    branchId: z.string().uuid("O ID da filial deve ser um UUID válido."),
    supplierId: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .uuid("O ID do fornecedor deve ser um UUID válido.")
        .optional()
        .nullable(),
    ),

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
  )
  .refine(
    (data) => {
      // Check the relationship between dates only if both exist
      if (data.completion_date && data.date) {
        const orderDate = new Date(data.date);
        const completionDate = new Date(data.completion_date);

        return completionDate >= orderDate;
      }

      // If there is no completion date, or if only one of the dates exists, validation passes.
      return true;
    },
    {
      message:
        "A data de conclusão não pode ser anterior à data da ordem de serviço",
      path: ["completion_date"],
    },
  )
  .refine(
    (data) => {
      // Validation: Last service must be <= current mileage (snapshot)
      if (
        data.last_maintenance_mileage_at_service &&
        data.current_mileage_at_service
      ) {
        return (
          data.last_maintenance_mileage_at_service <=
          data.current_mileage_at_service
        );
      }

      return true;
    },
    {
      message:
        "A quilometragem da última revisão não pode ser superior à quilometragem atual",
      path: ["last_maintenance_mileage_at_service"],
    },
  )
  .refine(
    (data) => {
      // Validation: if it is finalizing, new mileage is mandatory
      if (data.completion_date && !data.new_mileage_after_service) {
        return false;
      }

      return true;
    },
    {
      message:
        "A nova quilometragem é obrigatória quando a ordem de serviço é finalizada",
      path: ["new_mileage_after_service"],
    },
  )
  .refine(
    (data) => {
      // Validation: new mileage must be > current mileage (strictly greater)
      if (data.new_mileage_after_service && data.current_mileage_at_service) {
        return data.new_mileage_after_service > data.current_mileage_at_service;
      }

      return true;
    },
    {
      message:
        "A nova quilometragem deve ser maior que a quilometragem atual do veículo",
      path: ["new_mileage_after_service"],
    },
  );

export { createServiceOrderSchema };

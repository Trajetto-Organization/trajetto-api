import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import { isPickedDateInput } from "@/shared/vehicle/record-dates";

import { LocationSource } from "@prisma/client";
import { isWithinAllowedDistance } from "@/shared/utils/geolocation";

import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const updateServiceOrderSchema = z
  .object({
    ...tenantLockedShape,
    date: z
      .string()
      .min(1, "Data da ordem de serviço é obrigatória.")
      .superRefine((val, ctx) => {
        if (!isPickedDateInput(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Data da ordem de serviço inválida",
          });

          return;
        }
      })
      .optional(),
    completion_date: z
      .preprocess(
        emptyStringToNull,
        z
          .string()
          .transform((val) => (val && val.trim() !== "" ? val : null))
          .nullable()
          .optional()
          .refine(
            (val) => !val || isPickedDateInput(val),
            "Data de conclusão inválida",
          ),
      )
      .nullable(),
    description: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .max(500, "A descrição deve ter no máximo 500 caracteres.")
        .superRefine((value, ctx) => {
          if (hasConsecutiveSpaces(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "A descrição não deve conter espaços consecutivos.",
            });

            return;
          }

          if (hasSpaceAtEdges(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "A descrição não pode começar ou terminar com espaço em branco.",
            });
          }
        })
        .optional()
        .nullable()
        .describe("Descrição livre do que se trata a ordem de serviço."),
    ),
    maintenance_type: z
      .enum(["INTERNAL", "EXTERNAL"], {
        errorMap: () => ({
          message: "Tipo de manutenção inválido. Deve ser INTERNAL ou EXTERNAL",
        }),
      })
      .optional(),
    total_amount: z
      .number()
      .nonnegative("O valor total deve ser um valor não negativo.")
      .min(1, "O valor total deve ser no mínimo R$ 1,00")
      .max(9999999.99, "O valor total não pode exceder 9.999.999,99.")
      .optional(),
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
        .max(9999999, "A quilometragem atual não pode exceder 9.999.999 km.")
        .optional()
        .nullable(),
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
        )
        .optional()
        .nullable(),
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
        )
        .optional()
        .nullable(),
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
    vehicleId: z.string().uuid("ID do veículo é inválido.").optional(),
    responsibleUserId: z
      .string()
      .uuid("ID do usuário responsável é inválido.")
      .optional(),
    branchId: z.string().uuid("ID da filial é inválido.").optional(),
    supplierId: z.preprocess(
      emptyStringToNull,
      z.string().uuid("ID do fornecedor é inválido.").optional().nullable(),
    ),

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
  );

export { updateServiceOrderSchema };

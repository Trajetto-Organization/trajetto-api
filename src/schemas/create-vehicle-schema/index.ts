import { z } from "zod";
import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
  isValidDateString,
} from "@/shared/utils/zod-schema-helpers";

const createVehicleSchema = z
  .object({
    description: z
      .string()
      .min(3, "A descrição deve ter no mínimo 3 caracteres.")
      .max(100, "A descrição deve ter no máximo 100 caracteres.")
      .superRefine((value, ctx) => {
        if (isEmptyOrWhitespace(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A descrição não pode ser vazia ou conter apenas espaços.",
          });

          return;
        }

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

          return;
        }
      }),
    license_plate: z
      .string()
      .min(7, "A placa deve ter no mínimo 7 caracteres.")
      .max(8, "A placa deve ter no máximo 8 caracteres.")
      .superRefine((value, ctx) => {
        if (isEmptyOrWhitespace(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A placa não pode ser vazia ou conter apenas espaços.",
          });

          return;
        }

        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A placa não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "A placa não pode começar ou terminar com espaço em branco.",
          });

          return;
        }

        // Validate the plate format (ABC1234 or ABC1D23)
        if (
          !/^[A-Za-z]{3}\d{4}$|^[A-Za-z]{3}\d{1}[A-Za-z]{1}\d{2}$/.test(value)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A placa deve estar no formato ABC1234 ou ABC1D23.",
          });
        }
      }),
    brand: z
      .string()
      .min(2, "A marca deve ter no mínimo 2 caracteres.")
      .max(50, "A marca deve ter no máximo 50 caracteres.")
      .superRefine((value, ctx) => {
        if (isEmptyOrWhitespace(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A marca não pode ser vazia ou conter apenas espaços.",
          });

          return;
        }

        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A marca não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "A marca não pode começar ou terminar com espaço em branco.",
          });

          return;
        }
      }),
    model: z
      .string()
      .min(2, "O modelo deve ter no mínimo 2 caracteres.")
      .max(50, "O modelo deve ter no máximo 50 caracteres.")
      .superRefine((value, ctx) => {
        if (isEmptyOrWhitespace(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "O modelo não pode ser vazio ou conter apenas espaços.",
          });

          return;
        }

        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "O modelo não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O modelo não pode começar ou terminar com espaço em branco.",
          });

          return;
        }
      }),
    acquisition_date: z
      .string()
      .min(1, "A data de aquisição é obrigatória.")
      .superRefine((val, ctx) => {
        if (!isValidDateString(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Data de aquisição inválida.",
          });

          return;
        }
      }),
    fleet_type: z.enum(["OWNED", "THIRD_PARTY"], {
      errorMap: () => ({
        message: "Tipo de frota inválido. Deve ser OWNED ou THIRD_PARTY",
      }),
    }),
    fleet_id: z.string().optional().nullable(),
    last_maintenance_date: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .transform((val) => (val && val.trim() !== "" ? val : null))
        .nullable()
        .optional()
        .refine(
          (val) => !val || isValidDateString(val),
          "Data da última manutenção inválida",
        ),
    ),
    current_mileage: z
      .number()
      .nonnegative("A quilometragem atual deve ser um valor não negativo.")
      .min(0.1, "A quilometragem atual deve ser maior que zero.")
      .max(9999999, "A quilometragem atual não pode exceder 9.999.999 km."),
    last_maintenance_mileage: z.preprocess(
      emptyStringToNull,
      z
        .number()
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
    maintenance_interval_km: z
      .number()
      .min(0.1, "O intervalo de revisão em km deve ser maior que zero.")
      .positive("O intervalo de revisão em km deve ser um valor positivo.")
      .max(100000, "O intervalo de revisão não pode exceder 100.000 km."),
    maintenance_interval_months: z
      .number()
      .int("O intervalo de manutenção deve ser um número inteiro.")
      .positive(
        "O intervalo de manutenção em meses deve ser um valor positivo.",
      )
      .min(1, "O intervalo de manutenção deve ser no mínimo de 1 mês.")
      .max(60, "O intervalo de manutenção não pode exceder 60 meses (5 anos)."),
    renavam: z
      .string()
      .length(11, "O RENAVAM deve ter exatamente 11 dígitos.")
      .regex(/^\d+$/, "O RENAVAM deve conter apenas números."),
    manufacturing_year: z
      .string()
      .min(1, "O ano de fabricação de fabricação é obrigatório.")
      .superRefine((val, ctx) => {
        if (!isValidDateString(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Ano de fabricação inválido.",
          });

          return;
        }
      }),
    model_year: z
      .string()
      .min(1, "O ano do modelo é obrigatório.")
      .superRefine((val, ctx) => {
        if (!isValidDateString(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Ano do modelo inválido.",
          });

          return;
        }
      }),
    km_per_liter: z
      .number()
      .int("O consumo em km/l deve ser um número inteiro.")
      .positive("O consumo em km/l deve ser um valor positivo.")
      .min(1, "O consumo em km/l deve ser no mínimo 1.")
      .max(50, "O consumo em km/l não pode exceder 50."),
    number_of_axles: z
      .number()
      .int("O número de eixos deve ser um número inteiro.")
      .min(1, "O número de eixos deve ser no mínimo 1.")
      .max(10, "O número de eixos não pode exceder 10."),
    status: z.enum(["ACTIVE", "INACTIVE", "BLOCKED", "IN_ROUTE"], {
      errorMap: () => ({
        message:
          "Status inválido. Deve ser ACTIVE, INACTIVE, BLOCKED ou IN_ROUTE",
      }),
    }),
    vehicleTypeId: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .uuid("O ID do tipo de veículo deve ser um UUID válido.")
        .optional()
        .nullable(),
    ),
    fuelTypeId: z
      .string()
      .uuid("O ID do tipo de combustível deve ser um UUID válido."),
    driverId: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .uuid("O ID do motorista deve ser um UUID válido.")
        .optional()
        .nullable(),
    ),
    branchId: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .uuid("O ID da filial deve ser um UUID válido.")
        .optional()
        .nullable(),
    ),
  })
  .refine(
    (data) => {
      if (data.manufacturing_year && data.model_year) {
        const manufacturingDate = new Date(data.manufacturing_year);
        const modelDate = new Date(data.model_year);

        // Extract only the year
        const manufacturingYear = manufacturingDate.getFullYear();
        const modelYear = modelDate.getFullYear();

        // The model year can be the same or up to one year older than the year of manufacture.
        return (
          modelYear >= manufacturingYear && modelYear <= manufacturingYear + 1
        );
      }

      // If any of the dates are missing, validation passes.
      return true;
    },
    {
      message:
        "O ano do modelo deve ser igual ao ano de fabricação ou no máximo um ano posterior",
      path: ["model_year"],
    },
  )
  .refine(
    (data) => {
      if (data.last_maintenance_mileage && data.current_mileage) {
        return data.last_maintenance_mileage <= data.current_mileage;
      }

      // If any of the mileages are missing, validation passes.
      return true;
    },
    {
      message:
        "A quilometragem da última revisão não pode ser superior à quilometragem atual",
      path: ["last_maintenance_mileage"],
    },
  );

export { createVehicleSchema };

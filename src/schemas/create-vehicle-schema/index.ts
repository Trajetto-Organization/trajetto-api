import { z } from "zod";
import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
  isValidDateString,
} from "@/shared/utils/zod-schema-helpers";

import {
  isModelYearCoherent,
  maxManufacturingYear,
  maxModelYear,
  vehicleYearOf,
} from "@/shared/vehicle/vehicle-years";

/**
 * The vehicle's fields, written ONCE for create and update (FLEET-VEH-2).
 *
 * The two schemas used to be copies that drifted: create accepted one axle
 * and update demanded two, and the form resends every field, so a vehicle
 * registered with one axle could never be edited again (not even its
 * description). Update also took fractional months against an Int column,
 * which Prisma refused as a 500. Update is now this object made partial.
 */

interface TextMessages {
  min: string;
  max: string;
  empty: string;
  consecutive: string;
  edges: string;
}

function plainText(min: number, max: number, messages: TextMessages) {
  return z
    .string()
    .min(min, messages.min)
    .max(max, messages.max)
    .superRefine((value, ctx) => {
      const message = isEmptyOrWhitespace(value)
        ? messages.empty
        : hasConsecutiveSpaces(value)
          ? messages.consecutive
          : hasSpaceAtEdges(value)
            ? messages.edges
            : null;

      if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    });
}

function dateString(required: string, invalid: string) {
  return z
    .string()
    .min(1, required)
    .refine((value) => isValidDateString(value), invalid);
}

/** A number with at most `places` decimals (km/l is kept to the hundredth). */
function hasAtMostDecimals(value: number, places: number): boolean {
  const scaled = value * 10 ** places;

  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

// Mercosul (ABC1D23) or the old format (ABC1234). Uppercased before the
// check: the unique index is case-sensitive, so "abc1d23" and "ABC1D23" were
// two different plates to the database.
const PLATE_PATTERN = /^[A-Z]{3}\d[A-Z0-9]\d{2}$/;

const licensePlate = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z
    .string({ required_error: "A placa é obrigatória." })
    .min(7, "A placa deve ter 7 caracteres.")
    .max(7, "A placa deve ter 7 caracteres.")
    .regex(PLATE_PATTERN, "A placa deve estar no formato ABC1234 ou ABC1D23."),
);

const manufacturingYear = dateString(
  "O ano de fabricação é obrigatório.",
  "Ano de fabricação inválido.",
).refine(
  (value) => vehicleYearOf(value) <= maxManufacturingYear(),
  () => ({
    message: `O ano de fabricação não pode ser posterior a ${maxManufacturingYear()}.`,
  }),
);

const modelYear = dateString(
  "O ano do modelo é obrigatório.",
  "Ano do modelo inválido.",
).refine(
  (value) => vehicleYearOf(value) <= maxModelYear(),
  () => ({
    message: `O ano do modelo não pode ser posterior a ${maxModelYear()}.`,
  }),
);

const optionalUuid = (message: string) =>
  z.preprocess(
    emptyStringToNull,
    z.string().uuid(message).optional().nullable(),
  );

const vehicleFieldsSchema = z.object({
  description: plainText(3, 100, {
    min: "A descrição deve ter no mínimo 3 caracteres.",
    max: "A descrição deve ter no máximo 100 caracteres.",
    empty: "A descrição não pode ser vazia ou conter apenas espaços.",
    consecutive: "A descrição não deve conter espaços consecutivos.",
    edges: "A descrição não pode começar ou terminar com espaço em branco.",
  }),
  license_plate: licensePlate,
  brand: plainText(2, 50, {
    min: "A marca deve ter no mínimo 2 caracteres.",
    max: "A marca deve ter no máximo 50 caracteres.",
    empty: "A marca não pode ser vazia ou conter apenas espaços.",
    consecutive: "A marca não deve conter espaços consecutivos.",
    edges: "A marca não pode começar ou terminar com espaço em branco.",
  }),
  model: plainText(2, 50, {
    min: "O modelo deve ter no mínimo 2 caracteres.",
    max: "O modelo deve ter no máximo 50 caracteres.",
    empty: "O modelo não pode ser vazio ou conter apenas espaços.",
    consecutive: "O modelo não deve conter espaços consecutivos.",
    edges: "O modelo não pode começar ou terminar com espaço em branco.",
  }),
  acquisition_date: dateString(
    "A data de aquisição é obrigatória.",
    "Data de aquisição inválida.",
  ),
  fleet_type: z.enum(["OWNED", "THIRD_PARTY"], {
    errorMap: () => ({
      message: "Tipo de frota inválido. Deve ser OWNED ou THIRD_PARTY.",
    }),
  }),
  // Free text with no ceiling used to reach the column as-is.
  fleet_id: z.preprocess(
    emptyStringToNull,
    plainText(1, 50, {
      min: "O identificador da frota não pode ser vazio.",
      max: "O identificador da frota deve ter no máximo 50 caracteres.",
      empty: "O identificador da frota não pode conter apenas espaços.",
      consecutive:
        "O identificador da frota não deve conter espaços consecutivos.",
      edges:
        "O identificador da frota não pode começar ou terminar com espaço em branco.",
    })
      .optional()
      .nullable(),
  ),
  last_maintenance_date: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .refine(
        (value) => isValidDateString(value),
        "Data da última manutenção inválida.",
      )
      .optional()
      .nullable(),
  ),
  current_mileage: z
    .number({ invalid_type_error: "A quilometragem atual deve ser um número." })
    .min(0.1, "A quilometragem atual deve ser maior que zero.")
    .max(9999999, "A quilometragem atual não pode exceder 9.999.999 km."),
  last_maintenance_mileage: z.preprocess(
    emptyStringToNull,
    z
      .number()
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
    .max(100000, "O intervalo de revisão não pode exceder 100.000 km."),
  maintenance_interval_months: z
    .number()
    .int("O intervalo de manutenção deve ser um número inteiro de meses.")
    .min(1, "O intervalo de manutenção deve ser no mínimo de 1 mês.")
    .max(60, "O intervalo de manutenção não pode exceder 60 meses (5 anos)."),
  renavam: z
    .string()
    .length(11, "O RENAVAM deve ter exatamente 11 dígitos.")
    .regex(/^\d+$/, "O RENAVAM deve conter apenas números."),
  manufacturing_year: manufacturingYear,
  model_year: modelYear,
  // Fractional since decision 8.6: a truck does 2,5–4 km/l.
  km_per_liter: z
    .number()
    .min(0.1, "O consumo deve ser de no mínimo 0,1 km/l.")
    .max(50, "O consumo não pode exceder 50 km/l.")
    .refine(
      (value) => hasAtMostDecimals(value, 2),
      "O consumo aceita no máximo duas casas decimais.",
    ),
  number_of_axles: z
    .number()
    .int("O número de eixos deve ser um número inteiro.")
    .min(1, "O número de eixos deve ser no mínimo 1.")
    .max(10, "O número de eixos não pode exceder 10."),
  // IN_ROUTE is deliberately absent: it is a fact about a route, written by
  // the route when it departs and cleared when it ends.
  status: z.enum(["ACTIVE", "INACTIVE", "BLOCKED"], {
    errorMap: () => ({
      message: "Status inválido. Deve ser ACTIVE, INACTIVE ou BLOCKED.",
    }),
  }),
  vehicleTypeId: optionalUuid("ID do tipo de veículo é inválido."),
  fuelTypeId: z
    .string({ required_error: "ID do tipo de combustível é obrigatório!" })
    .uuid("ID do tipo de combustível é inválido."),
  driverId: optionalUuid("ID do motorista é inválido."),
  branchId: optionalUuid("ID da filial é inválido."),
});

/**
 * The rules between fields, applied whenever BOTH sides are in the payload
 * (an update that changes one side is checked against the stored other side
 * by the use case).
 */
function checkCrossFields(
  data: {
    manufacturing_year?: string;
    model_year?: string;
    current_mileage?: number | null;
    last_maintenance_mileage?: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    data.manufacturing_year &&
    data.model_year &&
    isValidDateString(data.manufacturing_year) &&
    isValidDateString(data.model_year) &&
    !isModelYearCoherent(
      vehicleYearOf(data.manufacturing_year),
      vehicleYearOf(data.model_year),
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["model_year"],
      message:
        "O ano do modelo deve ser igual ao ano de fabricação ou no máximo um ano posterior.",
    });
  }

  if (
    typeof data.last_maintenance_mileage === "number" &&
    typeof data.current_mileage === "number" &&
    data.last_maintenance_mileage > data.current_mileage
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["last_maintenance_mileage"],
      message:
        "A quilometragem da última revisão não pode ser superior à quilometragem atual.",
    });
  }
}

const createVehicleSchema = vehicleFieldsSchema.superRefine(checkCrossFields);

export {
  createVehicleSchema,
  vehicleFieldsSchema,
  checkCrossFields,
  PLATE_PATTERN,
};

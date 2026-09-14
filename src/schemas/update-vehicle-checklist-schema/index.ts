import { z } from "zod";

import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
  isValidDateString,
} from "@/shared/utils/zod-schema-helpers";

const updateVehicleChecklistSchema = z.object({
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
        invalid_type_error: "A quilometragem atual deve ser um número válido.",
      })
      .nonnegative("A quilometragem atual deve ser um valor não negativo.")
      .min(0.1, "A quilometragem atual deve ser maior que zero.")
      .max(9999999, "A quilometragem atual não pode exceder 9.999.999 km.")
      .optional(),
  ),
  checklist_date: z
    .string()
    .min(1, "A data do checklist é obrigatória.")
    .superRefine((val, ctx) => {
      if (val && !isValidDateString(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A data do checklist deve ser uma data válida.",
        });
      }
    })
    .optional(),
  tires_condition: z
    .enum(["good", "bad", "needs_attention"], {
      required_error: "A condição dos pneus é obrigatória.",
      invalid_type_error:
        "Condição dos pneus inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
    })
    .optional(),
  headlights_working: z
    .boolean({
      required_error: "A verificação dos faróis é obrigatória.",
      invalid_type_error: "O status dos faróis deve ser verdadeiro ou falso.",
    })
    .optional(),
  taillights_working: z
    .boolean({
      required_error: "A verificação das lanternas é obrigatória.",
      invalid_type_error:
        "O status das lanternas deve ser verdadeiro ou falso.",
    })
    .optional(),
  turn_signals_working: z
    .boolean({
      required_error: "A verificação das setas é obrigatória.",
      invalid_type_error: "O status das setas deve ser verdadeiro ou falso.",
    })
    .optional(),
  bumpers_condition: z
    .enum(["good", "bad", "needs_attention"], {
      required_error: "A condição dos para-choques é obrigatória.",
      invalid_type_error:
        "Condição dos para-choques inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
    })
    .optional(),
  windshield_condition: z
    .enum(["good", "bad", "needs_attention"], {
      required_error: "A condição do para-brisa é obrigatória.",
      invalid_type_error:
        "Condição do para-brisa inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
    })
    .optional(),
  mirrors_condition: z
    .enum(["good", "bad", "needs_attention"], {
      required_error: "A condição dos retrovisores é obrigatória.",
      invalid_type_error:
        "Condição dos retrovisores inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
    })
    .optional(),
  seatbelts_working: z
    .boolean({
      required_error: "A verificação dos cintos de segurança é obrigatória.",
      invalid_type_error:
        "O status dos cintos de segurança deve ser verdadeiro ou falso.",
    })
    .optional(),
  dashboard_working: z
    .boolean({
      required_error: "A verificação do painel é obrigatória.",
      invalid_type_error: "O status do painel deve ser verdadeiro ou falso.",
    })
    .optional(),
  steering_wheel_condition: z
    .enum(["good", "bad", "needs_attention"], {
      required_error: "A condição do volante é obrigatória.",
      invalid_type_error:
        "Condição do volante inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
    })
    .optional(),
  brakes_working: z
    .boolean({
      required_error: "A verificação dos freios é obrigatória.",
      invalid_type_error: "O status dos freios deve ser verdadeiro ou falso.",
    })
    .optional(),
  clutch_working: z
    .boolean({
      required_error: "A verificação da embreagem é obrigatória.",
      invalid_type_error: "O status da embreagem deve ser verdadeiro ou falso.",
    })
    .optional(),
  fuel_level_adequate: z
    .boolean({
      required_error: "A verificação do nível de combustível é obrigatória.",
      invalid_type_error:
        "O status do nível de combustível deve ser verdadeiro ou falso.",
    })
    .optional(),
  oil_level_adequate: z
    .boolean({
      required_error: "A verificação do nível de óleo é obrigatória.",
      invalid_type_error:
        "O status do nível de óleo deve ser verdadeiro ou falso.",
    })
    .optional(),
  radiator_water_adequate: z
    .boolean({
      required_error: "A verificação da água do radiador é obrigatória.",
      invalid_type_error:
        "O status da água do radiador deve ser verdadeiro ou falso.",
    })
    .optional(),
  brake_fluid_adequate: z
    .boolean({
      required_error: "A verificação do fluido de freio é obrigatória.",
      invalid_type_error:
        "O status do fluido de freio deve ser verdadeiro ou falso.",
    })
    .optional(),
  battery_condition: z
    .enum(["good", "bad", "needs_attention"], {
      required_error: "A condição da bateria é obrigatória.",
      invalid_type_error:
        "Condição da bateria inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
    })
    .optional(),
  driver_license_valid: z
    .boolean({
      required_error: "A verificação da CNH é obrigatória.",
      invalid_type_error: "O status da CNH deve ser verdadeiro ou falso.",
    })
    .optional(),
  vehicle_documents_valid: z
    .boolean({
      required_error: "A verificação dos documentos do veículo é obrigatória.",
      invalid_type_error:
        "O status dos documentos do veículo deve ser verdadeiro ou falso.",
    })
    .optional(),
  insurance_valid: z
    .boolean({
      required_error: "A verificação do seguro é obrigatória.",
      invalid_type_error: "O status do seguro deve ser verdadeiro ou falso.",
    })
    .optional(),
  fire_extinguisher_valid: z
    .boolean({
      required_error: "A verificação do extintor é obrigatória.",
      invalid_type_error: "O status do extintor deve ser verdadeiro ou falso.",
    })
    .optional(),
  warning_triangle_present: z
    .boolean({
      required_error: "A verificação do triângulo é obrigatória.",
      invalid_type_error: "O status do triângulo deve ser verdadeiro ou falso.",
    })
    .optional(),
  jack_present: z
    .boolean({
      required_error: "A verificação do macaco é obrigatória.",
      invalid_type_error: "O status do macaco deve ser verdadeiro ou falso.",
    })
    .optional(),
  spare_tire_condition: z
    .enum(["good", "bad", "needs_attention"], {
      required_error: "A condição do estepe é obrigatória.",
      invalid_type_error:
        "Condição do estepe inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
    })
    .optional(),
  overall_condition: z
    .enum(["approved", "approved_with_restrictions", "rejected"], {
      required_error: "A condição geral é obrigatória.",
      invalid_type_error:
        "Condição geral inválida. Deve ser 'approved', 'approved_with_restrictions' ou 'rejected'.",
    })
    .optional(),
  vehicleId: z.string().uuid("ID do veículo é inválido.").optional(),
  driverId: z.string().uuid("ID do motorista é inválido.").optional(),
  branchId: z.string().uuid("ID da filial é inválido.").optional(),
  notes: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .max(500, "As observações devem ter no máximo 500 caracteres.")
      .optional()
      .nullable()
      .superRefine((value, ctx) => {
        if (value && typeof value === "string") {
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
                "As observações não podem começar ou terminar com espaços.",
            });

            return;
          }
        }
      }),
  ),
});

// Photos are validated by `presignedPhotosSchema`: they never reach this API
// as files, only as keys pointing at objects already in storage.
export { updateVehicleChecklistSchema };

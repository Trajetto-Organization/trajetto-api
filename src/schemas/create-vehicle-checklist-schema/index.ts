import { z } from "zod";
import { RecordOrigin } from "@prisma/client";

import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
  isValidDateString,
} from "@/shared/utils/zod-schema-helpers";

const createVehicleChecklistSchema = z.object({
  client_submission_id: z
    .string()
    .uuid("A chave de idempotência do envio é inválida.")
    .optional(),
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
        invalid_type_error: "A quilometragem atual deve ser um número válido.",
      })
      .nonnegative("A quilometragem atual deve ser um valor não negativo.")
      .min(0.1, "A quilometragem atual deve ser maior que zero.")
      .max(9999999, "A quilometragem atual não pode exceder 9.999.999 km."),
  ),
  checklist_date: z
    .string()
    .min(1, "A data do checklist é obrigatória.")
    .optional()
    .superRefine((val, ctx) => {
      if (val && !isValidDateString(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Data do checklist inválida.",
        });

        return;
      }

      if (val) {
        // Validation: checklist date cannot be in the future
        const checklistDate = new Date(val);
        const today = new Date();

        today.setHours(23, 59, 59, 999); // End of today

        if (checklistDate > today) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A data do checklist não pode ser no futuro.",
          });

          return;
        }
      }
    }),
  tires_condition: z.enum(["good", "bad", "needs_attention"], {
    required_error: "A condição dos pneus é obrigatória.",
    invalid_type_error:
      "Condição dos pneus inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
  }),
  headlights_working: z.boolean({
    required_error: "A verificação dos faróis é obrigatória.",
    invalid_type_error: "O status dos faróis deve ser verdadeiro ou falso.",
  }),
  taillights_working: z.boolean({
    required_error: "A verificação das lanternas é obrigatória.",
    invalid_type_error: "O status das lanternas deve ser verdadeiro ou falso.",
  }),
  turn_signals_working: z.boolean({
    required_error: "A verificação das setas é obrigatória.",
    invalid_type_error: "O status das setas deve ser verdadeiro ou falso.",
  }),
  bumpers_condition: z.enum(["good", "bad", "needs_attention"], {
    required_error: "A condição dos para-choques é obrigatória.",
    invalid_type_error:
      "Condição dos para-choques inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
  }),
  windshield_condition: z.enum(["good", "bad", "needs_attention"], {
    required_error: "A condição do para-brisa é obrigatória.",
    invalid_type_error:
      "Condição do para-brisa inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
  }),
  mirrors_condition: z.enum(["good", "bad", "needs_attention"], {
    required_error: "A condição dos retrovisores é obrigatória.",
    invalid_type_error:
      "Condição dos retrovisores inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
  }),
  seatbelts_working: z.boolean({
    required_error: "A verificação dos cintos de segurança é obrigatória.",
    invalid_type_error:
      "O status dos cintos de segurança deve ser verdadeiro ou falso.",
  }),
  dashboard_working: z.boolean({
    required_error: "A verificação do painel é obrigatória.",
    invalid_type_error: "O status do painel deve ser verdadeiro ou falso.",
  }),
  steering_wheel_condition: z.enum(["good", "bad", "needs_attention"], {
    required_error: "A condição do volante é obrigatória.",
    invalid_type_error:
      "Condição do volante inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
  }),
  brakes_working: z.boolean({
    required_error: "A verificação dos freios é obrigatória.",
    invalid_type_error: "O status dos freios deve ser verdadeiro ou falso.",
  }),
  clutch_working: z.boolean({
    required_error: "A verificação da embreagem é obrigatória.",
    invalid_type_error: "O status da embreagem deve ser verdadeiro ou falso.",
  }),
  fuel_level_adequate: z.boolean({
    required_error: "A verificação do nível de combustível é obrigatória.",
    invalid_type_error:
      "O status do nível de combustível deve ser verdadeiro ou falso.",
  }),
  oil_level_adequate: z.boolean({
    required_error: "A verificação do nível de óleo é obrigatória.",
    invalid_type_error:
      "O status do nível de óleo deve ser verdadeiro ou falso.",
  }),
  radiator_water_adequate: z.boolean({
    required_error: "A verificação da água do radiador é obrigatória.",
    invalid_type_error:
      "O status da água do radiador deve ser verdadeiro ou falso.",
  }),
  brake_fluid_adequate: z.boolean({
    required_error: "A verificação do fluido de freio é obrigatória.",
    invalid_type_error:
      "O status do fluido de freio deve ser verdadeiro ou falso.",
  }),
  battery_condition: z.enum(["good", "bad", "needs_attention"], {
    required_error: "A condição da bateria é obrigatória.",
    invalid_type_error:
      "Condição da bateria inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
  }),
  driver_license_valid: z.boolean({
    required_error: "A verificação da CNH é obrigatória.",
    invalid_type_error: "O status da CNH deve ser verdadeiro ou falso.",
  }),
  vehicle_documents_valid: z.boolean({
    required_error: "A verificação dos documentos do veículo é obrigatória.",
    invalid_type_error:
      "O status dos documentos do veículo deve ser verdadeiro ou falso.",
  }),
  insurance_valid: z.boolean({
    required_error: "A verificação do seguro é obrigatória.",
    invalid_type_error: "O status do seguro deve ser verdadeiro ou falso.",
  }),
  fire_extinguisher_valid: z.boolean({
    required_error: "A verificação do extintor é obrigatória.",
    invalid_type_error: "O status do extintor deve ser verdadeiro ou falso.",
  }),
  warning_triangle_present: z.boolean({
    required_error: "A verificação do triângulo é obrigatória.",
    invalid_type_error: "O status do triângulo deve ser verdadeiro ou falso.",
  }),
  jack_present: z.boolean({
    required_error: "A verificação do macaco é obrigatória.",
    invalid_type_error: "O status do macaco deve ser verdadeiro ou falso.",
  }),
  spare_tire_condition: z.enum(["good", "bad", "needs_attention"], {
    required_error: "A condição do estepe é obrigatória.",
    invalid_type_error:
      "Condição do estepe inválida. Deve ser 'good', 'bad' ou 'needs_attention'.",
  }),
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
                "As observações não podem começar ou terminar com espaço em branco.",
            });

            return;
          }
        }
      }),
  ),
  overall_condition: z.enum(
    ["approved", "approved_with_restrictions", "rejected"],
    {
      required_error: "A condição geral é obrigatória.",
      invalid_type_error:
        "Condição geral inválida. Deve ser 'approved', 'approved_with_restrictions' ou 'rejected'.",
    },
  ),
  vehicleId: z
    .string({ required_error: "ID do veículo é obrigatório!" })
    .uuid("ID do veículo é inválido."),
  driverId: z.string().uuid("ID do motorista é inválido.").optional(),
  branchId: z.string().uuid("ID da filial é inválido.").optional(),

  // Optional on purpose: the web forms omit it and the column default
  // (WEB_DASHBOARD) applies; the mobile app sends MOBILE_APP explicitly.
  created_from: z
    .nativeEnum(RecordOrigin, {
      errorMap: () => ({
        message: "Origem inválida. Deve ser MOBILE_APP ou WEB_DASHBOARD.",
      }),
    })
    .optional()
    .describe("Origem do cadastro (MOBILE_APP ou WEB_DASHBOARD)."),
});

// Photos are validated by `presignedPhotosSchema`: they never reach this API
// as files, only as keys pointing at objects already in storage.
export { createVehicleChecklistSchema };

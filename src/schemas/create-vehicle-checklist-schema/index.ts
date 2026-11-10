import { z } from "zod";

import { isPickedDateInput } from "@/shared/vehicle/record-dates";
import { RecordOrigin } from "@prisma/client";

import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";
import { devicePrecheckField } from "@/shared/ai-precheck/device-precheck";
import { occurredAtField } from "@/shared/delivery/occurred-at";

const createVehicleChecklistSchema = z.object({
  client_submission_id: z
    .string()
    .uuid("A chave de idempotência do envio é inválida.")
    .optional()
    .describe(
      "Chave de idempotência do envio (UUID), gerada uma vez pelo app e repetida em cada retentativa; o header Idempotency-Key preenche este campo quando ele vem vazio. Repetir a chave devolve o checklist já criado em vez de duplicar.",
    ),
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
    // "Not in the future" is the company's day, not the server's: the use
    // case checks it with Business.timezone (checklist-rules), because this
    // schema cannot know the company.
    .superRefine((val, ctx) => {
      if (val && !isPickedDateInput(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Data do checklist inválida.",
        });
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

  // Optional on purpose: the web's form omits it, sends no key and gets
  // WEB_DASHBOARD. A driver's checklist is MOBILE_APP whatever this says, and
  // one that omits it with a key is MOBILE_APP too: the use case decides it
  // (shared/vehicle/record-origin.ts), so the app build that never sent the
  // field is badged "App", whoever used it.
  created_from: z
    .nativeEnum(RecordOrigin, {
      errorMap: () => ({
        message: "Origem inválida. Deve ser MOBILE_APP ou WEB_DASHBOARD.",
      }),
    })
    .optional()
    .describe(
      "Origem do cadastro (MOBILE_APP ou WEB_DASHBOARD). Ausente, vale MOBILE_APP quando o envio traz a chave de idempotência (no corpo ou no header Idempotency-Key), que só o app manda, e WEB_DASHBOARD quando não traz. Para o motorista, o servidor grava sempre MOBILE_APP, seja qual for o valor enviado.",
    ),

  // Decision 14.2: the phone's offline check of the "Foto do Odômetro"
  // (field current_mileage). Dropped without that photo.
  device_precheck: devicePrecheckField,

  // Plan of 02/11/2026 (C4/F3): the route this checklist was made for and
  // its moment. Both or neither; the use case checks the route is the
  // driver's and the vehicle is the route's, and that a driver's arrival
  // waits for the route to be resolved (shared/vehicle/route-link.ts).
  routeId: z
    .string()
    .uuid("ID da rota é inválido.")
    .nullable()
    .optional()
    .describe(
      "A rota para a qual o checklist foi feito (checklist de saída ou de chegada). Exige `phase`. A rota tem de ser do motorista do checklist e ter o veículo do checklist (senão 422 ROUTE_LINK_MISMATCH); rota inexistente ou de outra empresa: 404 DELIVERY_ROUTE_NOT_FOUND. Para o checklist de saída o status da rota não importa: um checklist feito sem sinal pode chegar depois do início. O de chegada do motorista só vale com a rota iniciada (ou já encerrada) e todas as paradas resolvidas (concluída, com insucesso ou cancelada), quaisquer que sejam a ordem e as paradas incluídas com a rota em andamento; antes disso, o app que envia `contract` 5 ou maior em `x-trajetto-client-version` recebe 409 CHECKLIST_ARRIVAL_ROUTE_OPEN, e o de versão anterior (ou sem o cabeçalho) tem o checklist gravado e marcado na atividade com as paradas em aberto. Para o mesmo app, o de chegada também precisa ser datado depois da última entrega da rota (parada concluída ou com insucesso depois dele, com 5 minutos de folga): senão, 409 CHECKLIST_ARRIVAL_BEFORE_ROUTE_END, definitivo. O checklist feito pelo escritório não passa por essa regra. A rota informada também vale como a atribuição do veículo ao motorista (o substituto que levou o caminhão na rota faz o checklist dele mesmo depois do fim).",
    ),
  phase: z
    .enum(["STANDALONE", "ROUTE_START", "ROUTE_END"], {
      errorMap: () => ({
        message:
          "Fase inválida. Deve ser STANDALONE, ROUTE_START ou ROUTE_END.",
      }),
    })
    .optional()
    .describe(
      "O momento: ROUTE_START (saída) ou ROUTE_END (chegada) com `routeId`; STANDALONE (padrão) sem rota. A chegada do motorista espera a rota iniciada e todas as paradas resolvidas (ver `routeId`).",
    ),

  // K6: when the driver finished the inspection, for a checklist the app
  // queued offline. With X-Client-Sent-At it replaces checklist_date.
  occurred_at: occurredAtField,
});

// Photos are validated by `presignedPhotosSchema`: they never reach this API
// as files, only as keys pointing at objects already in storage.
export { createVehicleChecklistSchema };

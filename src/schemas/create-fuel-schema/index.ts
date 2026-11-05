import { z } from "zod";

import { isPickedDateInput } from "@/shared/vehicle/record-dates";
import { APP_SUBMISSION_KEY_REQUIRED } from "@/shared/vehicle/record-origin";

import { LocationSource, RecordOrigin } from "@prisma/client";
import { isWithinAllowedDistance } from "@/shared/utils/geolocation";
import { devicePrecheckField } from "@/shared/ai-precheck/device-precheck";
import { occurredAtField } from "@/shared/delivery/occurred-at";
import { RECENT_REASON_MAX_LENGTH } from "@/modules/fuel/usecases/fuel-rules";

import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";

const createFuelSchema = z
  .object({
    client_submission_id: z
      .string()
      .uuid("A chave de idempotência do envio é inválida.")
      .optional()
      .describe(
        "Chave de idempotência do envio (UUID), gerada uma vez pelo app e repetida em cada retentativa; o header Idempotency-Key preenche este campo quando ele vem vazio. Repetir a chave devolve o abastecimento já criado em vez de duplicar. Obrigatória quando created_from = MOBILE_APP e em todo abastecimento de motorista, cuja origem é sempre MOBILE_APP.",
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
        // Sanity cap (decision 15.9): no fuel costs more than R$ 50/L; a typed
        // 599 used to be saved as R$ 599/L. Mirrored by the web and the app.
        .max(50, "O preço por litro não pode exceder R$ 50,00."),
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
        if (!isPickedDateInput(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Data do abastecimento inválida.",
          });

          return;
        }

        // "Not in the future" needs the company's calendar, which a schema
        // does not have: the use case checks it (fuel-rules.ts). The
        // server's end of day let tomorrow through from 21:00 in São Paulo.
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

    // 🆕 RECORD ORIGIN: Track where the record was created. A driver's is
    // MOBILE_APP whatever this says: the use case decides it from the caller
    // (shared/vehicle/record-origin.ts), and the app's rules follow it.
    created_from: z
      .nativeEnum(RecordOrigin, {
        errorMap: () => ({
          message: "Origem inválida. Deve ser MOBILE_APP ou WEB_DASHBOARD.",
        }),
      })
      .describe(
        "Origem do cadastro: MOBILE_APP ou WEB_DASHBOARD. Para o motorista, o servidor grava sempre MOBILE_APP, seja qual for o valor enviado, e exige o que o app sempre manda: a localização GPS e a chave de idempotência.",
      ),

    // Decision 14.2: the phone's offline check of the odometer photo.
    device_precheck: devicePrecheckField,

    // Plan of 02/11/2026 (C5/F3): the route the refuelling was made on.
    routeId: z
      .string()
      .uuid("ID da rota é inválido.")
      .nullable()
      .optional()
      .describe(
        "A rota em que o abastecimento foi feito (abastecimento a partir da rota no app). A rota tem de ser do motorista do abastecimento e ter o veículo dele (senão 422 ROUTE_LINK_MISMATCH); rota inexistente ou de outra empresa: 404 DELIVERY_ROUTE_NOT_FOUND. O status da rota não importa: um abastecimento feito sem sinal pode chegar depois do fim. A rota informada também vale como a atribuição do veículo ao motorista, mesmo depois do fim.",
      ),

    // K6: when the driver refuelled, for a refuelling the app queued
    // offline. With X-Client-Sent-At it replaces refueling_date.
    occurred_at: occurredAtField,

    // 05/11/2026: the driver's answer to "another refuelling of this
    // vehicle less than 30 minutes ago" (fuel-rules.ts). Not columns: the
    // use case keeps the reason only when the alert holds.
    confirm_recent: z
      .boolean({
        invalid_type_error: "A confirmação deve ser verdadeiro ou falso.",
      })
      .optional()
      .describe(
        "O motorista confirmou um segundo abastecimento do veículo em menos de 30 minutos. Vale com `recent_reason` de 3 caracteres ou mais; sem os dois, o app de `contract` 5 ou maior recebe 409 FUEL_RECENT_REFUEL.",
      ),
    recent_reason: z
      .string({ invalid_type_error: "O motivo deve ser um texto." })
      .trim()
      .max(
        RECENT_REASON_MAX_LENGTH,
        `O motivo deve ter no máximo ${RECENT_REASON_MAX_LENGTH} caracteres.`,
      )
      .optional()
      .describe(
        "Por que o motorista abasteceu de novo em menos de 30 minutos (de 3 a 300 caracteres, sem os espaços das pontas). Guardado no abastecimento, com o alerta RECENT_REFUEL, quando `confirm_recent` é true.",
      ),
  })
  // 🆕 VALIDATION: Distance check for GPS_MANUAL (manual adjustment)
  .refine(
    (data) => {
      // If location source is GPS_MANUAL, validate distance
      if (
        data.location_source === LocationSource.GPS_MANUAL &&
        data.latitude != null &&
        data.longitude != null &&
        data.latitude_original != null &&
        data.longitude_original != null
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
  .superRefine((data, ctx) => {
    if (
      data.created_from === RecordOrigin.MOBILE_APP &&
      !data.client_submission_id
    ) {
      // The use case refuses a driver's refuelling without it in the same
      // words, whatever origin the body claimed (appSubmissionKeyRefusal).
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: APP_SUBMISSION_KEY_REQUIRED,
        path: ["client_submission_id"],
      });
    }
  });

// The odometer photo is validated by `presignedPhotoSchema`: it never reaches
// this API as a file, only as a key pointing at an object already in storage.
export { createFuelSchema };

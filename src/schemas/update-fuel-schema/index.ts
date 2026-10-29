import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import { isPickedDateInput } from "@/shared/vehicle/record-dates";

import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";

const updateFuelSchema = z
  .object({
    ...tenantLockedShape,
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
          invalid_type_error:
            "A quilometragem atual deve ser um número válido.",
        })
        .nonnegative("A quilometragem atual deve ser um valor não negativo.")
        .min(0.1, "A quilometragem atual deve ser maior que zero.")
        .max(9999999, "A quilometragem atual não pode exceder 9.999.999 km.")
        .optional(),
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
          invalid_type_error:
            "A quantidade de litros deve ser um número válido.",
        })
        .positive("A quantidade de litros deve ser um valor positivo.")
        .min(0.001, "A quantidade de litros deve ser maior que zero.")
        .max(99999.999, "A quantidade de litros não pode exceder 99.999,999 L.")
        .optional(),
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
          invalid_type_error: "O preço por litro deve ser um número válido.",
        })
        .positive("O preço por litro deve ser um valor positivo.")
        .min(0.01, "O preço por litro deve ser no mínimo R$ 0,01")
        // Sanity cap (decision 15.9): no fuel costs more than R$ 50/L; a typed
        // 599 used to be saved as R$ 599/L. Mirrored by the web and the app.
        .max(50, "O preço por litro não pode exceder R$ 50,00.")
        .optional(),
    ),
    notes: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .max(500, "As observações devem ter no máximo 500 caracteres.")
        .superRefine((value, ctx) => {
          if (!value || value === "") {
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
        })
        .optional()
        .nullable(),
    ),
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
      })
      .optional(),
    vehicleId: z.string().uuid("ID do veículo é inválido.").optional(),
    driverId: z.string().uuid("ID do motorista é inválido.").optional(),
    fuelTypeId: z
      .string()
      .uuid("ID do tipo de combustível é inválido.")
      .optional(),
    branchId: z.string().uuid("ID da filial é inválido.").optional(),

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

    // Not accepted here, on purpose: the stored photo path, the AI's
    // odometer verdict and the location's audit (original GPS fix, source,
    // who edited and when) are written by the server. Accepted from the
    // body, a user with fuel write pointed the record at any storage key —
    // another company's photo, signed back to them by the list — marked an
    // odometer as verified, or forged who moved the location. Unknown keys
    // are stripped, so older clients sending them keep working.
  })
  .strip();

// The replacement photo is validated by `presignedPhotoSchema`: it never
// reaches this API as a file, only as a key pointing at an object already in
// storage.
export { updateFuelSchema };

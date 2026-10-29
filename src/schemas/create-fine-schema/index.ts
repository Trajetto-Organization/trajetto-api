import { z } from "zod";

import { LocationSource, RecordOrigin } from "@prisma/client";
import { isWithinAllowedDistance } from "@/shared/utils/geolocation";

import {
  amountField,
  coordinateField,
  dateField,
  locationField,
  observationField,
  paymentDateField,
  pointsField,
} from "./fine-fields";

const createFineSchema = z
  .object({
    violation_date: dateField("data da infração"),
    due_date: dateField("data de vencimento"),
    payment_date: paymentDateField,
    amount: amountField,
    // Optional: without it the use case takes the code's points.
    points: pointsField.optional(),
    location: locationField,
    observation: observationField,
    branchId: z
      .string({ required_error: "ID da filial é obrigatório!" })
      .uuid("ID da filial é inválido."),
    driverId: z
      .string({ required_error: "ID do motorista é obrigatório!" })
      .uuid("ID do motorista é inválido."),
    vehicleId: z
      .string({ required_error: "ID do veículo é obrigatório!" })
      .uuid("ID do veículo é inválido."),
    trafficViolationCodeId: z
      .string({ required_error: "ID do código de infração é obrigatório!" })
      .uuid("ID do código de infração é inválido."),

    // 📍 GEOLOCATION: Final location (edited or original)
    latitude: coordinateField(-90, 90, "latitude"),
    longitude: coordinateField(-180, 180, "longitude"),

    // 📍 GEOLOCATION: Original GPS fix, sent by the app only; the use case
    // ignores it for web records.
    latitude_original: coordinateField(-90, 90, "latitude original"),
    longitude_original: coordinateField(-180, 180, "longitude original"),

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

      return true;
    },
    {
      message:
        "A localização editada está muito distante da localização capturada pelo GPS (máximo 500m permitido).",
      path: ["latitude"],
    },
  );

export { createFineSchema };

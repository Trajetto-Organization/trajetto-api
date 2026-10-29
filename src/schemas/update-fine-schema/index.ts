import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import {
  amountField,
  coordinateField,
  dateField,
  locationField,
  observationField,
  paymentDateField,
  pointsField,
} from "@/schemas/create-fine-schema/fine-fields";

/**
 * The fine edit: every field optional, the same rules as the create.
 *
 * The location audit (who moved the point, when, from which GPS fix, and
 * the source) is written by the use case only. The schema used to accept
 * `location_edited_by`, `location_edited_at`, `location_source` and the
 * original coordinates from the request, so a client could sign a location
 * edit with any user's id. Unknown keys are stripped.
 */
const updateFineSchema = z.object({
  ...tenantLockedShape,
  violation_date: dateField("data da infração").optional(),
  due_date: dateField("data de vencimento").optional(),
  payment_date: paymentDateField,
  amount: amountField.optional(),
  points: pointsField.optional(),
  location: locationField,
  observation: observationField,
  branchId: z.string().uuid("ID da filial é inválido.").optional(),
  driverId: z.string().uuid("ID do motorista é inválido.").optional(),
  vehicleId: z.string().uuid("ID do veículo é inválido.").optional(),
  trafficViolationCodeId: z
    .string()
    .uuid("ID do código de infração é inválido.")
    .optional(),

  // 📍 GEOLOCATION: the point placed on the map; null removes it.
  latitude: coordinateField(-90, 90, "latitude"),
  longitude: coordinateField(-180, 180, "longitude"),
});

export { updateFineSchema };

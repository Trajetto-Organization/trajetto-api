import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import {
  checkCrossFields,
  vehicleFieldsSchema,
} from "@/schemas/create-vehicle-schema";

/**
 * The create schema's fields, each optional (FLEET-VEH-2): one definition, so
 * a limit changed for one path is changed for both. The form sends only what
 * changed; what it omits stays as stored.
 */
const updateVehicleSchema = vehicleFieldsSchema
  .partial()
  .extend({
    ...tenantLockedShape,
    /**
     * IN_ROUTE still parses here, and only here, on purpose: an older client
     * that loads a vehicle currently out and saves an unrelated field sends
     * the status back unchanged. Setting it as a CHANGE is refused by the use
     * case — the route owns that value.
     */
    status: z
      .enum(["ACTIVE", "INACTIVE", "BLOCKED", "IN_ROUTE"], {
        errorMap: () => ({
          message:
            "Status inválido. Deve ser ACTIVE, INACTIVE, BLOCKED ou IN_ROUTE.",
        }),
      })
      .optional(),
    // Only a MASTER may correct the odometer (the use case enforces it), and
    // a correction may bring it down to zero.
    current_mileage: z
      .number()
      .nonnegative("A quilometragem atual deve ser um valor não negativo.")
      .max(9999999, "A quilometragem atual não pode exceder 9.999.999 km.")
      .optional()
      .nullable(),
  })
  .superRefine(checkCrossFields);

export { updateVehicleSchema };

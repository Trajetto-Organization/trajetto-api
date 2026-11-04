import { createDeliverySchema } from "@/schemas/create-delivery-schema";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

/**
 * The edit accepts every field of the create, with two rules the use case
 * enforces because they depend on the row (decision 5.2):
 *
 * - `invoice_key` and `invoice_number` are set ONCE: accepted while the
 *   delivery has no key yet, immutable after. The key is the dedupe anchor
 *   of the NF-e import and travels to the customers' ERPs.
 * - `items` are editable only on a delivery that did not come from an NF-e
 *   XML: there the items are what the note declared.
 *
 * A delivery with a wrong key cannot be fixed in place: cancel it and create
 * another with a different key (the unique index covers cancelled ones too).
 *
 * The address point given at the create (plan of 02/11/2026, E1) is not
 * edited here: moving it is the route map's "Fixar no mapa", which also
 * moves the plan version of the route holding the stop. An address edit
 * clears it (CLEARED_ADDRESS_POINT).
 */
const updateDeliverySchema = createDeliverySchema
  .omit({ latitude: true, longitude: true })
  .partial()
  .extend(tenantLockedShape);

export { updateDeliverySchema };

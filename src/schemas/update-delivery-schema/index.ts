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
 */
const updateDeliverySchema = createDeliverySchema.partial().extend(tenantLockedShape);

export { updateDeliverySchema };

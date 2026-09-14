import { createDeliverySchema } from "@/schemas/create-delivery-schema";

// Items and invoice_key are frozen after creation: items are the cargo the
// NFe declared, and the key is the identity of the delivery. A wrong note
// is solved by cancelling and recreating, never by editing in place.
const updateDeliverySchema = createDeliverySchema
  .omit({ items: true, invoice_key: true, invoice_number: true })
  .partial();

export { updateDeliverySchema };

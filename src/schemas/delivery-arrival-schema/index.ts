import { z } from "zod";

/**
 * Every driver mutation carries a client_submission_id: the app's outbox
 * resends after dead networks, and the database unique on it is what makes
 * a resend a no-op instead of a duplicate.
 */
const deliveryArrivalSchema = z.object({
  client_submission_id: z
    .string({
      required_error: "A chave de idempotência do envio é obrigatória.",
    })
    .uuid("A chave de idempotência do envio é inválida."),
  latitude: z.coerce
    .number({ required_error: "A latitude é obrigatória." })
    .min(-90)
    .max(90),
  longitude: z.coerce
    .number({ required_error: "A longitude é obrigatória." })
    .min(-180)
    .max(180),
});

export { deliveryArrivalSchema };

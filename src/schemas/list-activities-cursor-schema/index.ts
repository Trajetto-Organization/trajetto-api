import { z } from "zod";

/**
 * Real validation for the timeline feed, run in the controller.
 *
 * The route schema documents the wire format with plain strings and no
 * transforms — fastify-type-provider-zod would otherwise parse the
 * querystring, replace `request.query` with the transformed object, and this
 * second parse would receive numbers where it expects strings.
 */
const listActivitiesCursorSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Quantidade por página do feed (padrão 20, máximo 50)."),

  /** Id of the last row the client already has — uuid v7, so time-ordered. */
  cursor: z.string().uuid().optional(),

  search: z.string().optional(),

  /**
   * The window the cards above the feed describe. It belongs to the cursor's
   * contract: changing it is a different result set, so the client must drop
   * the cursor and start over.
   */
  period: z.enum(["7d", "30d"]).default("7d"),

  /** MASTER only: narrows the feed to a single company. */
  businessId: z.string().optional(),
});

export { listActivitiesCursorSchema };

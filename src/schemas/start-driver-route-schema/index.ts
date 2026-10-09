import { z } from "zod";

import { occurredAtField } from "@/shared/delivery/occurred-at";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

/**
 * The legacy departure's body. It never had one — every build in the field
 * posts `{}` or nothing — so this is read leniently by the controller and is
 * NOT declared as the route's body schema: a strict one would turn a
 * bodiless request from an older app into a 400 its outbox parks forever.
 */
const startDriverRouteSchema = z.object({
  // Documented here; enforced by the controller (it reads this body leniently).
  ...tenantLockedShape,
  occurred_at: occurredAtField,
});

export { startDriverRouteSchema };

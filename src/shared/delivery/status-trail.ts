import { env } from "@/env";

/**
 * Whether a delivery's own status lines are written (plano-escala F2-06):
 * the creation's STATUS_CHANGE from nothing to PENDING, and the SYSTEM
 * STATUS_CHANGE of each delivery a route moves by itself.
 *
 * Gated by DELIVERY_STATUS_TRAIL_ENABLED, off by default. The readers of
 * this image already tell those lines apart (the import undo, the public
 * events feed, the tower's authorization rule and feed); the image before
 * it does not, and it keeps serving during the rolling deploy and after a
 * code rollback. So the release ships the readers, and the writers start
 * when the owner turns this on, once nothing older serves: the order the
 * migrations keep for a new enum value, with an environment variable in
 * the place of the release that follows.
 *
 * Only the lines: the status still moves, and the departure still tells the
 * customers' systems (`delivery.in_transit`), with it on or off. Read at
 * call time: the env is the process's, and the tests switch it.
 */
function deliveryStatusTrailEnabled(): boolean {
  return env.DELIVERY_STATUS_TRAIL_ENABLED;
}

export { deliveryStatusTrailEnabled };

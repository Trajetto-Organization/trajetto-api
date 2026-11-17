import { afterAll, beforeAll } from "vitest";

import { env } from "@/env";

/**
 * A delivery's trail without its creation line (plano-escala F2-06).
 *
 * With DELIVERY_STATUS_TRAIL_ENABLED on, every delivery made through the
 * repository starts with a STATUS_CHANGE from nothing ("Entrega criada"), in
 * the twin as in Postgres. A test about what one action wrote reads what came
 * after it; the creation line itself is tested where it is written.
 */
function withoutCreationLine<
  T extends {
    type: string;
    status_from?: string | null;
    status_to?: string | null;
  },
>(events: T[]): T[] {
  return events.filter(
    (event) =>
      !(
        event.type === "STATUS_CHANGE" &&
        event.status_from === null &&
        event.status_to === "PENDING"
      ),
  );
}

/**
 * Turns the F2-06 status lines on (DELIVERY_STATUS_TRAIL_ENABLED, off by
 * default) for the tests of the file or describe it is called in, and puts
 * the value back after them. Called before the hooks that seed, so the seeds
 * write the lines too. For the tests about those lines, or that count them;
 * the default is tested in status-trail-flag and in
 * delivery-status-change-invariant.
 */
function withStatusTrail(): void {
  let saved = env.DELIVERY_STATUS_TRAIL_ENABLED;

  beforeAll(() => {
    saved = env.DELIVERY_STATUS_TRAIL_ENABLED;
    env.DELIVERY_STATUS_TRAIL_ENABLED = true;
  });

  afterAll(() => {
    env.DELIVERY_STATUS_TRAIL_ENABLED = saved;
  });
}

export { withStatusTrail, withoutCreationLine };

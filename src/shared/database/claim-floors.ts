import database from "@/../infra/database";
import { env } from "@/env";

import { createClaimFloors } from "./queue-claim-floor";

/**
 * The process's claim floors (queue-claim-floor.ts, plano-escala F5-13):
 * on the claims' own pool, read again every CLAIM_FLOOR_REFRESH_MS, and
 * only with QUEUE_CLAIM_ID_FLOOR_ENABLED; off, every claim is the one it
 * always was.
 */
const claimFloors = createClaimFloors({
  db: database,
  enabled: () => env.QUEUE_CLAIM_ID_FLOOR_ENABLED,
});

export { claimFloors };

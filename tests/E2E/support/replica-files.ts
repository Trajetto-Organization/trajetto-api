/**
 * The E2E files that start whole API replicas as processes of their own
 * (pipeline-replica-process.ts, replica-process.ts, or a spawn of their own).
 *
 * Vitest counts one fork per file; a replica is one, two or three more Node
 * processes it does not see. Run beside the rest of the suite, on a 4-vCPU
 * runner (the repositories became public on 30/10/2026: 3 forks instead of
 * 1), they amplified the load on every file that waits on timing. So
 * `yarn test:e2e` (infra/scripts/run-e2e.mjs) runs the suite in two phases,
 * picked by E2E_PHASE in vite.config.mts:
 *
 *  - `shared`: everything else, files in parallel;
 *  - `replicas`: these, one file at a time, after the first phase.
 *
 * tests/unitaires/quality/e2e-replica-isolation.test.ts fails when a file
 * that starts replicas is missing here, or a name here no longer exists.
 * Names only: matched as `**\/<name>` so the list works with or without
 * `--dir ./tests/E2E`.
 */
const REPLICA_E2E_FILES = [
  "control-tower-socket-chain.test.ts",
  "multi-replica-events.test.ts",
  "resilience-crash-after-accept.test.ts",
  "resilience-database-loss.test.ts",
  "resilience-provider-outage.test.ts",
  "resilience-redis-loss.test.ts",
  "resilience-replica-drain.test.ts",
  "socket-chat-replicas.test.ts",
  "socket-revocation.test.ts",
  "socket-support-ticket-replicas.test.ts",
] as const;

/** E2E_PHASE values (vite.config.mts). Unset: every file, as always. */
const E2E_PHASE_SHARED = "shared";
const E2E_PHASE_REPLICAS = "replicas";

const replicaFileGlobs = (): string[] =>
  REPLICA_E2E_FILES.map((name) => `**/${name}`);

export {
  E2E_PHASE_REPLICAS,
  E2E_PHASE_SHARED,
  REPLICA_E2E_FILES,
  replicaFileGlobs,
};

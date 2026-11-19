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
  "process-roles-replicas.test.ts",
  "resilience-crash-after-accept.test.ts",
  "resilience-database-loss.test.ts",
  "resilience-provider-outage.test.ts",
  "resilience-push-batch-stop.test.ts",
  "resilience-redis-loss.test.ts",
  "resilience-replica-drain.test.ts",
  "socket-chat-replicas.test.ts",
  "socket-emitter-replicas.test.ts",
  "socket-revocation.test.ts",
  "socket-support-ticket-replicas.test.ts",
] as const;

/**
 * The E2E files that measure something the whole cluster can disturb, and
 * so also run in the one-file-at-a-time phase. Postgres prunes a page's
 * dead row versions only below the oldest transaction id still running
 * ANYWHERE in the cluster (the snapshot's xmin), not just in the file's own
 * database: a write transaction open in another file's database stops the
 * pruning a HOT update needs (plano-escala F2-13), as it would freeze the
 * integration feed's horizon (F2-05) and hold the dashboard's rollup, which
 * waits for every write transaction open in the cluster before it settles a
 * changed day (F4-21), past the test's timeout. Not checked for replicas;
 * tests/unitaires/quality/e2e-replica-isolation.test.ts fails when a file
 * that waits on that horizon is missing here.
 */
const SERIAL_E2E_FILES = [
  "driver-last-position-hot.test.ts",
  "integration-feed-commit-order.test.ts",
  "integration-feed-across-window.test.ts",
  "tenant-day-rollup.test.ts",
  "tenant-day-rollup-repository-contract.test.ts",
] as const;

/** E2E_PHASE values (vite.config.mts). Unset: every file, as always. */
const E2E_PHASE_SHARED = "shared";
const E2E_PHASE_REPLICAS = "replicas";
const E2E_PHASE_INFRA = "infra";

/**
 * The infra phase's files (plano-escala F4-38): tests/E2E/infra, against a
 * real PgBouncer and a real standby that tests/E2E/infra/run.sh (`yarn
 * test:e2e:infra`) starts for them. Never in the shared or the replicas
 * phase, which have neither; in the CI, job 1 runs them after its slice
 * (validate.yml). tests/unitaires/quality/e2e-infra-isolation.test.ts
 * checks both. Relative to `--dir ./tests/E2E` or to the root alike.
 */
const INFRA_E2E_GLOB = "**/infra/**/*.test.ts";

/** Every file of the one-file-at-a-time phase: replicas and cluster-sensitive. */
const replicaFileGlobs = (): string[] =>
  [...REPLICA_E2E_FILES, ...SERIAL_E2E_FILES].map((name) => `**/${name}`);

export {
  E2E_PHASE_INFRA,
  E2E_PHASE_REPLICAS,
  E2E_PHASE_SHARED,
  INFRA_E2E_GLOB,
  REPLICA_E2E_FILES,
  SERIAL_E2E_FILES,
  replicaFileGlobs,
};

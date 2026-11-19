import type { Prisma } from "@prisma/client";

/**
 * Whether the cluster's epoch row still describes the cluster (plano-escala
 * U-14).
 *
 * cluster_epoch holds one epoch with the pair it was taken from: the
 * cluster's system_identifier (a new cluster: a logical restore, a
 * pg_upgrade) and its timeline (a PITR, a promote). The release step bumps
 * the epoch when the pair changes (infra/sql/50-cluster-epoch.sql). Between
 * a restore or a failover and that step, the transaction ids are being
 * handed out again under the OLD epoch — exactly what the epoch in the
 * integration feed's cursor exists to tell apart (F2-04, F2-05). So the
 * ops heartbeat compares the pair every minute and alerts
 * cluster-epoch-stale until the step runs.
 *
 * The timeline is the current WAL position's, as in the step: right after
 * a promote, pg_control_checkpoint() keeps the old one until the new
 * timeline's first checkpoint (minutes), and the step and this check would
 * both see nothing (F4-44). pg_control_system(), pg_control_checkpoint(),
 * pg_is_in_recovery(), pg_current_wal_lsn() and pg_walfile_name() are
 * executable by every role on Postgres 16 (tests/E2E/cluster-epoch.test.ts
 * runs them as trajetto_batch), and the runtime roles read cluster_epoch:
 * the check works the same after the cut of the database roles. One row
 * and a few function calls a minute.
 */

interface ClusterIdentity {
  /** pg_control_system().system_identifier, as text: it is a 64-bit id. */
  systemIdentifier: string;
  timeline: number;
}

interface ClusterEpochState {
  /** The row; null when the release step never wrote it. */
  stored: (ClusterIdentity & { epoch: number }) | null;

  /** What the cluster says now. */
  current: ClusterIdentity;
}

type RawClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * The row and the cluster's pair, or null while the table does not exist
 * (a database the release with U-14 has not migrated yet).
 */
async function readClusterEpochState(
  client: RawClient,
): Promise<ClusterEpochState | null> {
  const [table] = await client.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('cluster_epoch') IS NOT NULL AS present
  `;

  if (!table?.present) return null;

  const [row] = await client.$queryRaw<
    Array<{
      epoch: number | null;
      stored_system: string | null;
      stored_timeline: number | null;
      system: string;
      timeline: number;
    }>
  >`
    SELECT
      e."epoch" AS epoch,
      e."system_identifier"::text AS stored_system,
      e."timeline" AS stored_timeline,
      s.system_identifier::text AS system,
      CASE
        WHEN pg_is_in_recovery() THEN c.timeline_id
        ELSE ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::integer
      END AS timeline
    FROM pg_control_system() s
    CROSS JOIN pg_control_checkpoint() c
    LEFT JOIN "cluster_epoch" e ON e."id" = 1
  `;

  if (!row) return null;

  return {
    stored:
      row.epoch === null ||
      row.stored_system === null ||
      row.stored_timeline === null
        ? null
        : {
            epoch: row.epoch,
            systemIdentifier: row.stored_system,
            timeline: row.stored_timeline,
          },
    current: { systemIdentifier: row.system, timeline: row.timeline },
  };
}

/**
 * Why the epoch is stale, in pt-BR, or null when the row describes the
 * cluster.
 */
function clusterEpochStaleReason(state: ClusterEpochState): string | null {
  const { stored, current } = state;

  if (!stored) {
    return "cluster_epoch sem linha: a etapa de release ainda não rodou neste banco";
  }

  const changes: string[] = [];

  if (stored.systemIdentifier !== current.systemIdentifier) {
    changes.push(
      `system_identifier ${stored.systemIdentifier} → ${current.systemIdentifier} (um cluster novo: restore lógico ou pg_upgrade)`,
    );
  }

  if (stored.timeline !== current.timeline) {
    changes.push(
      `timeline ${stored.timeline} → ${current.timeline} (um PITR ou um promote)`,
    );
  }

  if (changes.length === 0) return null;

  return `época ${stored.epoch} velha: ${changes.join("; ")}`;
}

export {
  clusterEpochStaleReason,
  readClusterEpochState,
  type ClusterEpochState,
  type ClusterIdentity,
};

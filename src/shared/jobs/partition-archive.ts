import { databaseBatch } from "@/../infra/database";
import { env } from "@/env";
import { missingArchiveSettings } from "@/shared/archive/archive-settings";
import {
  archiveStorageFromEnv,
  type ArchiveStorage,
} from "@/shared/archive/archive-storage";
import {
  archiveHistoryPartition,
  historySourceOf,
} from "@/shared/archive/history-archive";
import {
  archiveTrailPartition,
  trailSourceOf,
  type ArchiveDatabase,
  type ArchiveVerdict,
} from "@/shared/archive/trail-archive";
import type { JobContext, JobHandler } from "@/shared/jobs/job-runner";
import { PermanentJobError } from "@/shared/jobs/job-errors";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "jobs", kind: "PARTITION_ARCHIVE" });

/**
 * The PARTITION_ARCHIVE job (plano-escala F3-28): one day of the GPS trail
 * copied to the archive bucket, off the nightly cron. The partition job
 * (partition-maintenance) used to archive inline, inside its own lease and
 * its five-minute budget, and a day bigger than the budget took nights.
 * Now the cron only enqueues the day (one live job per partition, the
 * subject) and keeps it attached; the day leaves on a later night, when
 * archive_partition says its manifest adds up and no job for it is still
 * running (createTrailArchiveGate, mode "job").
 *
 * The work is archiveTrailPartition's, crash-safe by construction: a
 * company's manifest row is PENDING before its object goes up and ARCHIVED
 * after, and a rerun skips what is ARCHIVED and rewrites the same key for
 * what is not. So a SIGKILL anywhere resumes, on whichever process claims
 * the job after its lease, without a second object. The job runs it in
 * slices of ARCHIVE_SLICE_MS, a checkpoint between them: a SIGTERM stops
 * at the next slice and hands the job back.
 *
 * A day whose manifest does not add up (a row that landed after the count)
 * fails the attempt and is retried with the runner's backoff; after the
 * last attempt the job is FAILED and the day stays attached, which the
 * partition-stuck alert counts.
 *
 * The same job archives a partition of the delivery history (plano-escala
 * F5-16, shared/archive/history-archive.ts): a month of delivery_event or
 * activity, or the `_older` partition, by the table in the payload. The
 * slices, the checkpoints and the verdict are the same; `from` is empty
 * for the partition FROM (MINVALUE), and `rewriteBefore` (the DROP's final
 * pass, F5-17) writes again every object older than it.
 */

interface PartitionArchivePayload {
  /** The trail table (driver_position_v2, driver_position). */
  table: string;

  /** The partition, by name. */
  name: string;

  /** Its range, ISO; `from` is empty for a FROM (MINVALUE) partition. */
  from: string;
  to: string;

  /** History only: rewrite every object written before this, ISO. */
  rewriteBefore?: string;
}

interface PartitionArchiveDeps {
  db: ArchiveDatabase;
  storage: () => ArchiveStorage | null;

  /** Names of the settings missing when `storage` is null, for the log. */
  missing?: () => readonly string[];
  sliceMs?: number;
  pageSize?: number;
  now?: () => number;
}

/** How long one call of archiveTrailPartition may start new companies. */
const ARCHIVE_SLICE_MS = 60_000;

function payloadOf(job: JobContext): PartitionArchivePayload {
  const payload = (job.payload ?? {}) as Partial<PartitionArchivePayload>;

  if (
    typeof payload.table !== "string" ||
    typeof payload.name !== "string" ||
    typeof payload.from !== "string" ||
    typeof payload.to !== "string"
  ) {
    throw new PermanentJobError("PARTITION_ARCHIVE sem a partição");
  }

  return payload as PartitionArchivePayload;
}

function createPartitionArchiveJob(deps: PartitionArchiveDeps): JobHandler {
  const now = deps.now ?? Date.now;
  const sliceMs = deps.sliceMs ?? ARCHIVE_SLICE_MS;

  return {
    async run(job) {
      const payload = payloadOf(job);
      const source = trailSourceOf(payload.table);
      const history = historySourceOf(payload.table);

      if (!source && !history) {
        throw new PermanentJobError(
          `PARTITION_ARCHIVE: ${payload.table} não é uma tabela da trilha nem do histórico`,
        );
      }

      const storage = deps.storage();

      // The process that claimed it has no archive settings (a worker
      // whose Environment misses them): said, and the day stays attached.
      if (!storage) {
        throw new PermanentJobError(
          `arquivo sem configuração neste processo: ${(deps.missing?.() ?? []).join(", ")}`,
        );
      }

      const archiveSlice = (): Promise<ArchiveVerdict> => {
        if (history) {
          return archiveHistoryPartition(
            history,
            {
              name: payload.name,
              from: payload.from
                ? new Date(payload.from).getTime()
                : Number.NEGATIVE_INFINITY,
              to: new Date(payload.to).getTime(),
            },
            {
              db: deps.db,
              storage,
              deadline: now() + sliceMs,
              now,
              pageSize: deps.pageSize,
              rewriteBefore: payload.rewriteBefore
                ? new Date(payload.rewriteBefore)
                : undefined,
            },
          );
        }

        return archiveTrailPartition(
          source!,
          {
            name: payload.name,
            from: new Date(payload.from),
            to: new Date(payload.to),
          },
          {
            db: deps.db,
            storage,
            deadline: now() + sliceMs,
            now,
            pageSize: deps.pageSize,
          },
        );
      };

      for (let slice = 1; ; slice += 1) {
        job.throwIfStopped();

        const verdict = await archiveSlice();

        if (verdict.verified) {
          log.info(
            { jobId: job.id, partition: payload.name, ...verdict },
            history ? "history partition archived" : "trail partition archived",
          );
          return;
        }

        if (verdict.reason !== "budget") {
          throw new Error(
            `arquivo de ${payload.name} não confere: ${verdict.manifestRows} de ${verdict.rows} linhas no manifesto, ${verdict.pending} pendente(s)`,
          );
        }

        await job.checkpoint({ v: 1, slices: slice, written: verdict.written });
      }
    },
  };
}

/** The job as the runner registers it: the maintenance pool, the env. */
const partitionArchiveJob: JobHandler = createPartitionArchiveJob({
  db: databaseBatch,
  storage: () => archiveStorageFromEnv(env),
  missing: () => missingArchiveSettings(env),
});

export { ARCHIVE_SLICE_MS, createPartitionArchiveJob, partitionArchiveJob };
export type { PartitionArchiveDeps, PartitionArchivePayload };

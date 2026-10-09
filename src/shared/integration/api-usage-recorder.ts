import { Prisma } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import database from "@/../infra/database";

import { logger } from "@/shared/logging/logger";
import {
  businessDateKey,
  dateOnlyFromKey,
  resolveTimeZone,
} from "@/shared/time/business-day";

/** The shared logger (OBS-14): structured lines, filterable by component. */
const log = logger.child({ component: "api-usage" });

/**
 * Counts what a customer's system asked of us.
 *
 * Buffered in memory and flushed on a timer, not written per request. The
 * write is an UPDATE of one row per (key, day, route, class), and a hundred
 * requests a second against the same row is a hundred transactions queuing on
 * one lock — for a counter nobody reads in real time. Ten seconds of counts is
 * what a crash (SIGKILL) costs, which for "how many calls did their ERP make
 * yesterday" is nothing; a graceful shutdown writes the last batch.
 *
 * The route PATTERN is what is counted, never the URL. `/deliveries/:id`
 * aggregated by literal URL would be one row per document anybody looked at —
 * a request log with extra steps, and the cardinality that comes with it.
 */
interface UsageBucket {
  apiKeyId: string;
  businessId: string;

  /** The company's business day, "YYYY-MM-DD" (decision 1.1). */
  day: string;
  method: string;
  route: string;

  statusClass: number;
  count: number;

  /** Flushes this bucket already failed; dropped past MAX_FLUSH_ATTEMPTS. */
  failures: number;
}

const FLUSH_INTERVAL_MS = 10_000;

/**
 * A ceiling on what one process can hold between flushes.
 *
 * Reached only if something has gone wrong — a route pattern that is not a
 * pattern, a key issued per request, the database down for minutes — and the
 * answer is to drop counts rather than to grow without bound. A monitor is not
 * worth an out-of-memory.
 */
const MAX_BUCKETS = 5_000;

/** Buckets per INSERT: one round trip instead of one upsert each. */
const FLUSH_CHUNK_SIZE = 500;

/**
 * How many flushes a bucket may fail before it is given up on.
 *
 * A failed write used to lose the counts at once (the buffer is cleared before
 * writing). Now it goes back into the buffer and is tried on the next cycle —
 * a database blip costs ten seconds of delay, not the numbers — but a bucket
 * that keeps failing for a reason that will not change must not circle
 * forever.
 */
const MAX_FLUSH_ATTEMPTS = 3;

function bucketKey(
  bucket: Pick<UsageBucket, "apiKeyId" | "day" | "method" | "route" | "statusClass">,
): string {
  return [
    bucket.apiKeyId,
    bucket.day,
    bucket.method,
    bucket.route,
    bucket.statusClass,
  ].join("\u0000");
}

/**
 * The day a call belongs to: the civil day of the key's company.
 *
 * It was the UTC day, so a company in São Paulo saw "Hoje" reset at 21:00 and
 * the previous evening under "Hoje" until 03:00 (DLVB-33). Two replicas agree
 * because the zone is the company's, not the process's.
 */
function usageDay(at: Date, timeZone: string | null | undefined): string {
  return businessDateKey(at, resolveTimeZone(timeZone));
}

/**
 * 2, 4 or 5. Anything outside 200–599 is counted as a server problem, because
 * a status we cannot classify is a status we wrote wrong.
 */
function statusClassOf(status: number): number {
  if (status >= 200 && status < 400) return 2;
  if (status >= 400 && status < 500) return 4;

  return 5;
}

/** A write that can never succeed: the key or the company is gone. */
function isMissingParent(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2003") return true;

    // A raw statement surfaces Postgres' own code.
    if (error.code === "P2010") {
      return String(error.meta?.code ?? "") === "23503";
    }
  }

  return /23503|foreign key/i.test(String((error as Error)?.message ?? ""));
}

/**
 * One statement for a whole chunk.
 *
 * `unnest` turns the parallel arrays into rows; the unique bucket index
 * decides between insert and increment, so two replicas flushing the same
 * bucket in the same second add up instead of one replacing the other.
 */
async function upsertChunk(chunk: UsageBucket[]): Promise<void> {
  await database.$executeRaw`
    INSERT INTO "api_key_usage_daily"
      ("id", "apiKeyId", "businessId", "day", "method", "route",
       "status_class", "count", "updated_at")
    SELECT "id", "apiKeyId", "businessId", "day", "method", "route",
           "status_class", "count", now()
    FROM unnest(
      ${chunk.map(() => uuidV7())}::text[],
      ${chunk.map((bucket) => bucket.apiKeyId)}::text[],
      ${chunk.map((bucket) => bucket.businessId)}::text[],
      ${chunk.map((bucket) => bucket.day)}::date[],
      ${chunk.map((bucket) => bucket.method)}::text[],
      ${chunk.map((bucket) => bucket.route)}::text[],
      ${chunk.map((bucket) => bucket.statusClass)}::smallint[],
      ${chunk.map((bucket) => BigInt(bucket.count))}::bigint[]
    ) AS "bucket"("id", "apiKeyId", "businessId", "day", "method", "route",
                  "status_class", "count")
    ON CONFLICT ("apiKeyId", "day", "method", "route", "status_class")
    DO UPDATE SET
      "count" = "api_key_usage_daily"."count" + EXCLUDED."count",
      "updated_at" = now()
  `;
}

/** The single-bucket fallback, to isolate the one row a chunk failed on. */
async function upsertOne(bucket: UsageBucket): Promise<void> {
  const day = dateOnlyFromKey(bucket.day);

  await database.apiKeyUsageDaily.upsert({
    where: {
      apiKeyId_day_method_route_status_class: {
        apiKeyId: bucket.apiKeyId,
        day,
        method: bucket.method,
        route: bucket.route,
        status_class: bucket.statusClass,
      },
    },
    create: {
      apiKeyId: bucket.apiKeyId,
      businessId: bucket.businessId,
      day,
      method: bucket.method,
      route: bucket.route,
      status_class: bucket.statusClass,
      count: bucket.count,
    },
    update: { count: { increment: bucket.count } },
  });
}

class ApiUsageRecorder {
  private buckets = new Map<string, UsageBucket>();
  private timer: NodeJS.Timeout | null = null;

  private dropped = 0;

  record(props: {
    apiKeyId: string;
    businessId: string;

    /** The key's company zone; the default zone when unknown. */
    timeZone?: string | null;

    method: string;
    route: string;
    status: number;
    at?: Date;
  }): void {
    this.add({
      apiKeyId: props.apiKeyId,
      businessId: props.businessId,

      day: usageDay(props.at ?? new Date(), props.timeZone),
      method: props.method.toUpperCase(),
      route: props.route,

      statusClass: statusClassOf(props.status),
      count: 1,
      failures: 0,
    });
  }

  /** Merges into the buffer, respecting the ceiling. */
  private add(bucket: UsageBucket): void {
    const key = bucketKey(bucket);
    const existing = this.buckets.get(key);

    if (existing) {
      existing.count += bucket.count;
      existing.failures = Math.max(existing.failures, bucket.failures);
      return;
    }

    if (this.buckets.size >= MAX_BUCKETS) {
      this.dropped += bucket.count;
      return;
    }

    this.buckets.set(key, { ...bucket });
  }

  /** A bucket whose write failed goes back for the next cycle, or is dropped. */
  private requeue(bucket: UsageBucket, error: unknown): void {
    const failures = bucket.failures + 1;

    if (failures >= MAX_FLUSH_ATTEMPTS) {
      log.error(
        { err: error, apiKeyId: bucket.apiKeyId, day: bucket.day, count: bucket.count },
        "API usage counter dropped after repeated write failures",
      );
      return;
    }

    this.add({ ...bucket, failures });
  }

  /**
   * Writes what accumulated and clears the buffer FIRST.
   *
   * Taking the buffer before the await means requests arriving during the
   * write land in the next batch instead of being counted twice or lost — the
   * same reason the outbox claims rows before it sends them. What fails to be
   * written goes back into the buffer (requeue).
   */
  async flush(): Promise<number> {
    if (this.buckets.size === 0) return 0;

    const pending = [...this.buckets.values()];

    this.buckets.clear();

    if (this.dropped > 0) {
      log.warn(
        { dropped: this.dropped, maxBuckets: MAX_BUCKETS },
        "API usage calls not counted: the buffer reached its ceiling",
      );

      this.dropped = 0;
    }

    let written = 0;

    for (let start = 0; start < pending.length; start += FLUSH_CHUNK_SIZE) {
      const chunk = pending.slice(start, start + FLUSH_CHUNK_SIZE);

      try {
        await upsertChunk(chunk);

        written += chunk.length;
        continue;
      } catch (error) {
        // A missing parent fails the whole statement for one bucket: bucket
        // by bucket isolates it. Anything else (the database away) fails
        // them all alike and the whole chunk goes back.
        if (!isMissingParent(error)) {
          log.warn(
            { err: error, buckets: chunk.length },
            "API usage batch could not be written; kept for the next flush",
          );

          for (const bucket of chunk) this.requeue(bucket, error);

          continue;
        }
      }

      for (const bucket of chunk) {
        try {
          await upsertOne(bucket);

          written += 1;
        } catch (error) {
          if (isMissingParent(error)) {
            // A key or company deleted mid-flush takes its counts with it,
            // by cascade: there is nothing left to count against.
            log.warn(
              { apiKeyId: bucket.apiKeyId, day: bucket.day },
              "API usage counter discarded: its key or company no longer exists",
            );

            continue;
          }

          this.requeue(bucket, error);
        }
      }
    }

    return written;
  }

  initialize(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.flush().catch((error) => {
        log.error({ err: error }, "API usage flush cycle failed");
      });
    }, FLUSH_INTERVAL_MS);

    // Not `unref`: a process shutting down should write what it holds, and
    // `shutdown` below is what gets the last batch out.
    log.info("API usage counter started");
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);

    this.timer = null;

    // The last ten seconds, on the way out. Cheap, and it is the batch most
    // likely to be the one somebody asks about after a deploy.
    await this.flush().catch((error) => {
      log.error({ err: error }, "API usage final flush failed");
    });

    log.info("API usage counter stopped");
  }

  /** For tests: what is held but not yet written. */
  pending(): number {
    return this.buckets.size;
  }
}

const apiUsageRecorder = new ApiUsageRecorder();

export {
  ApiUsageRecorder,
  MAX_BUCKETS,
  MAX_FLUSH_ATTEMPTS,
  apiUsageRecorder,
  statusClassOf,
  usageDay,
};

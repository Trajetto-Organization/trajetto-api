import database from "@/../infra/database";

/**
 * Counts what a customer's system asked of us.
 *
 * Buffered in memory and flushed on a timer, not written per request. The
 * write is an UPDATE of one row per (key, day, route, class), and a hundred
 * requests a second against the same row is a hundred transactions queuing on
 * one lock — for a counter nobody reads in real time. Ten seconds of counts is
 * what a crash costs, which for "how many calls did their ERP make yesterday"
 * is nothing.
 *
 * The route PATTERN is what is counted, never the URL. `/deliveries/:id`
 * aggregated by literal URL would be one row per document anybody looked at —
 * a request log with extra steps, and the cardinality that comes with it.
 */
interface UsageBucket {
  apiKeyId: string;
  businessId: string;

  day: string;
  method: string;
  route: string;

  statusClass: number;
  count: number;
}

const FLUSH_INTERVAL_MS = 10_000;

/**
 * A ceiling on what one process can hold between flushes.
 *
 * Reached only if something has gone wrong — a route pattern that is not a
 * pattern, a key issued per request — and the answer is to drop counts rather
 * than to grow without bound. A monitor is not worth an out-of-memory.
 */
const MAX_BUCKETS = 5_000;

function bucketKey(bucket: Omit<UsageBucket, "count">): string {
  return [
    bucket.apiKeyId,
    bucket.day,
    bucket.method,
    bucket.route,
    bucket.statusClass,
  ].join("\u0000");
}

/** UTC, as a plain date string. The column is a DATE. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
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

class ApiUsageRecorder {
  private buckets = new Map<string, UsageBucket>();
  private timer: NodeJS.Timeout | null = null;

  private dropped = 0;

  record(props: {
    apiKeyId: string;
    businessId: string;
    method: string;
    route: string;
    status: number;
    at?: Date;
  }): void {
    const bucket = {
      apiKeyId: props.apiKeyId,
      businessId: props.businessId,

      day: utcDay(props.at ?? new Date()),
      method: props.method.toUpperCase(),
      route: props.route,

      statusClass: statusClassOf(props.status),
    };

    const key = bucketKey(bucket);
    const existing = this.buckets.get(key);

    if (existing) {
      existing.count += 1;
      return;
    }

    if (this.buckets.size >= MAX_BUCKETS) {
      this.dropped += 1;
      return;
    }

    this.buckets.set(key, { ...bucket, count: 1 });
  }

  /**
   * Writes what accumulated and clears the buffer FIRST.
   *
   * Taking the buffer before the await means requests arriving during the
   * write land in the next batch instead of being counted twice or lost — the
   * same reason the outbox claims rows before it sends them.
   */
  async flush(): Promise<number> {
    if (this.buckets.size === 0) return 0;

    const pending = [...this.buckets.values()];

    this.buckets.clear();

    if (this.dropped > 0) {
      console.warn(
        `[ApiUsage] ${this.dropped} chamadas não contabilizadas: o buffer atingiu o teto.`,
      );

      this.dropped = 0;
    }

    let written = 0;

    for (const bucket of pending) {
      try {
        // An upsert and not a read-then-write: two replicas flush at the same
        // second, and the unique index is what decides. `increment` so the
        // second one adds to the first instead of replacing it.
        await database.apiKeyUsageDaily.upsert({
          where: {
            apiKeyId_day_method_route_status_class: {
              apiKeyId: bucket.apiKeyId,
              day: new Date(`${bucket.day}T00:00:00.000Z`),
              method: bucket.method,
              route: bucket.route,
              status_class: bucket.statusClass,
            },
          },
          create: {
            apiKeyId: bucket.apiKeyId,
            businessId: bucket.businessId,
            day: new Date(`${bucket.day}T00:00:00.000Z`),
            method: bucket.method,
            route: bucket.route,
            status_class: bucket.statusClass,
            count: bucket.count,
          },
          update: { count: { increment: bucket.count } },
        });

        written += 1;
      } catch (error) {
        // A revoked key deleted mid-flush takes its counts with it, by
        // cascade. Losing a counter must never take down the process that was
        // only trying to write one.
        console.error("[ApiUsage] Falha ao gravar o contador:", error);
      }
    }

    return written;
  }

  initialize(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.flush().catch((error) => {
        console.error("[ApiUsage] Falha no ciclo de escrita:", error);
      });
    }, FLUSH_INTERVAL_MS);

    // Not `unref`: a process shutting down should write what it holds, and
    // `shutdown` below is what gets the last batch out.
    console.log("[ApiUsage] Contador iniciado");
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);

    this.timer = null;

    // The last ten seconds, on the way out. Cheap, and it is the batch most
    // likely to be the one somebody asks about after a deploy.
    await this.flush().catch((error) => {
      console.error("[ApiUsage] Falha na escrita final:", error);
    });

    console.log("[ApiUsage] Contador encerrado");
  }

  /** For tests: what is held but not yet written. */
  pending(): number {
    return this.buckets.size;
  }
}

const apiUsageRecorder = new ApiUsageRecorder();

export {
  ApiUsageRecorder,
  apiUsageRecorder,
  statusClassOf,
  utcDay,
  MAX_BUCKETS,
};

import { Prisma } from "@prisma/client";

import { logger } from "@/shared/logging/logger";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

import type { BatchDeleteClient } from "./batch-delete";

const log = logger.child({ component: "queue-claim-floor" });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How often a process asks again for its queues' oldest row in flight. A
 * row that comes into flight with an id older than the floor (a delivery
 * of an event older than yesterday, a settled row put back to PENDING)
 * waits at most this long for the next answer, and is claimed then.
 */
const CLAIM_FLOOR_REFRESH_MS = 30_000;

type ClaimFloorQueue = "outbox" | "deliveries" | "webhooks";

/** The ids in flight of one table, through a claim's partial index. */
function inFlightIds(table: string, channels?: string): string {
  return `SELECT "id" FROM "${table}"
        WHERE "status" IN ('PENDING', 'PROCESSING')${
          channels ? ` AND "channel" IN (${channels})` : ""
        } OFFSET 0`;
}

/** `min` and `max` of the ids of the sources, the queue's relkind too. */
function rangeSql(table: string, sources: string[]): Prisma.Sql {
  const each = sources.map((source, index) => `(${source}) s${index}`);

  return Prisma.raw(`
    SELECT
      (SELECT c.relkind = 'p' FROM pg_class c WHERE c.oid = to_regclass('"${table}"')) AS partitioned,
      least(${each.map((from) => `(SELECT min("id") FROM ${from})`).join(", ")}) AS oldest,
      greatest(${each.map((from) => `(SELECT max("id") FROM ${from})`).join(", ")}) AS newest
  `);
}

/**
 * The oldest and the newest id in flight that a claim of `queue` may have
 * to take, read through the claims' own partial indexes (OFFSET 0 keeps
 * the planner from walking the primary key from the oldest row up), and
 * whether the queue is partitioned at all. A delivery carries its event's
 * millisecond, so the deliveries' range also covers every event still to
 * expand: its deliveries are not written yet. Constant SQL: table and
 * channel names of this file, never input.
 */
const IN_FLIGHT_RANGE: Record<ClaimFloorQueue, Prisma.Sql> = {
  outbox: rangeSql("domain_outbox_event", [inFlightIds("domain_outbox_event")]),
  deliveries: rangeSql("notification_delivery", [
    inFlightIds("notification_delivery", "'EMAIL', 'WHATSAPP'"),
    inFlightIds("notification_delivery", "'IN_APP', 'ACTIVITY', 'PUSH'"),
    inFlightIds("domain_outbox_event"),
  ]),
  webhooks: rangeSql("webhook_delivery", [inFlightIds("webhook_delivery")]),
};

/**
 * The range of a claim: from the start of the UTC day of the oldest id in
 * flight, and never later than the start of yesterday (a replica whose
 * clock is behind mints ids a little older than now), to the end of the
 * day of the newest one, and never earlier than the end of tomorrow (one
 * whose clock is ahead). A partition is a day, so the range only has to
 * be right to the day. Null for a plain table: there is nothing to prune,
 * and a predicate on the id could only change a plan that works.
 */
function claimRangeOf(
  row:
    | {
        partitioned: boolean | null;
        oldest: string | null;
        newest: string | null;
      }
    | undefined,
  now: Date = new Date(),
): { floor: string; ceiling: string } | null {
  if (!row?.partitioned) return null;

  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const dayOf = (id: string | null) =>
    id ? Math.floor(uuid7Instant(id) / DAY_MS) * DAY_MS : Number.NaN;
  const oldest = dayOf(row.oldest);
  const newest = dayOf(row.newest);

  return {
    floor: uuid7Floor(
      Number.isFinite(oldest)
        ? Math.min(oldest, today - DAY_MS)
        : today - DAY_MS,
    ),
    ceiling: uuid7Floor(
      Number.isFinite(newest)
        ? Math.max(newest + DAY_MS, today + 2 * DAY_MS)
        : today + 2 * DAY_MS,
    ),
  };
}

/** The millisecond a uuid v7 starts with. */
function uuid7Instant(id: string): number {
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

interface ClaimFloors {
  /**
   * ` AND "id" >= floor AND "id" < ceiling` (of `alias`) for the queue's
   * claim, or nothing.
   */
  predicate(queue: ClaimFloorQueue, alias?: string): Promise<Prisma.Sql>;
}

/**
 * The partitioned queues' claim floors (plano-escala F5-13, plan B of the
 * 39-partition gate). A claim names no id, so it plans and probes every
 * partition of its queue, a month of days, several times a second on
 * every replica. With QUEUE_CLAIM_ID_FLOOR_ENABLED the claims add
 * `"id" >= floor AND "id" < ceiling`, which prunes the days that cannot
 * hold a row in flight (normally all but yesterday, today and tomorrow).
 *
 * Fail-open, never closed: a floor that cannot be read is none (the claim
 * as it always was), and every row in flight is under the floor's day by
 * construction, so none is left behind; a row that comes into flight
 * outside it waits for the next refresh, CLAIM_FLOOR_REFRESH_MS.
 */
function createClaimFloors(options: {
  db: BatchDeleteClient;
  enabled: () => boolean;
  refreshMs?: number;
  now?: () => Date;
}): ClaimFloors {
  const refreshMs = options.refreshMs ?? CLAIM_FLOOR_REFRESH_MS;
  const now = options.now ?? (() => new Date());
  const cache = new Map<
    ClaimFloorQueue,
    { at: number; range: Promise<{ floor: string; ceiling: string } | null> }
  >();

  async function read(
    queue: ClaimFloorQueue,
  ): Promise<{ floor: string; ceiling: string } | null> {
    try {
      const [row] = await options.db.$queryRaw<
        Array<{
          partitioned: boolean | null;
          oldest: string | null;
          newest: string | null;
        }>
      >(IN_FLIGHT_RANGE[queue]);

      return claimRangeOf(row, now());
    } catch (error) {
      log.warn(
        { queue, err: error },
        "claim floor unreadable: claiming without it",
      );

      return null;
    }
  }

  return {
    async predicate(queue, alias) {
      if (!options.enabled()) return Prisma.empty;

      const at = now().getTime();
      let entry = cache.get(queue);

      if (!entry || at - entry.at >= refreshMs) {
        entry = { at, range: read(queue) };
        cache.set(queue, entry);
      }

      const range = await entry.range;

      if (range === null) return Prisma.empty;

      const column = Prisma.raw(alias ? `"${alias}"."id"` : `"id"`);

      return Prisma.sql` AND ${column} >= ${range.floor} AND ${column} < ${range.ceiling}`;
    },
  };
}

export {
  CLAIM_FLOOR_REFRESH_MS,
  IN_FLIGHT_RANGE,
  claimRangeOf,
  createClaimFloors,
};
export type { ClaimFloorQueue, ClaimFloors };

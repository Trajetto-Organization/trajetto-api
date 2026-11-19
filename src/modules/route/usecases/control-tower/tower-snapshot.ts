import { env } from "@/env";
import { TenantSnapshot } from "@/shared/cache/tenant-snapshot";

/**
 * The snapshots of the three answers every operator of a carrier polls
 * (plano-escala F4-11, decision D2 of 15/11/2026): the control tower, the
 * operation summary and the first page of /route/live. Each depends on the
 * company alone, so in each process it is read once per interval
 * (TOWER_SNAPSHOT_TTL_MS, 10 s; 0 turns it off) and the other operators
 * get the same body, already serialized, with its ETag.
 *
 * The rules each use case keeps around it:
 *  - the permission and resolveOperationsBusiness run BEFORE the read, on
 *    every request: a copy never lets a request in, and the company of the
 *    key is the one the caller was allowed to read;
 *  - the compute reads the company's data and nothing of who asks: the
 *    body is the same for everyone of the company;
 *  - read on the primary, like every read of the tower (the replica's
 *    closed list in tests/unitaires/database/database-read-guard.test.ts
 *    has none of its repositories);
 *  - a refresh (x-trajetto-refresh) recomputes only a copy at least
 *    TOWER_SNAPSHOT_MIN_REFRESH_MS old: a panel that refetches on every
 *    event is still one read per company every 2 s.
 */

/** The shortest interval between two reads a refresh can force (decision D2). */
const TOWER_SNAPSHOT_MIN_REFRESH_MS = 2_000;

/**
 * A snapshot of one of the tower's answers, keyed by its name. The value is
 * the body the route would send, serialized by the route's own serializer
 * in the use case's compute, so a copy is byte for byte the answer.
 */
function towerSnapshot(name: string): TenantSnapshot<string> {
  return new TenantSnapshot<string>({
    name,
    ttlMs: () => env.TOWER_SNAPSHOT_TTL_MS,
    minRefreshMs: TOWER_SNAPSHOT_MIN_REFRESH_MS,
    serialize: (body) => body,
  });
}

/**
 * How the controller hands the use case its route's serializer: the value
 * becomes exactly the body reply.send would write for it.
 */
type SnapshotBody<T> = (value: T) => string;

export { TOWER_SNAPSHOT_MIN_REFRESH_MS, towerSnapshot, type SnapshotBody };

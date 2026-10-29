import type { PrismaClient } from "@prisma/client";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import { assertSessionEligible } from "@/modules/user/services/session-eligibility";
import { AppError } from "@/shared/errors/AppError";

import { mayReadDeliveries } from "./operations-access";

/**
 * Whether a live connection still belongs to a live session.
 *
 * The handshake checks everything once. After that, the only thing that
 * ended a socket was a `securityAction` crossing the Redis adapter — and the
 * adapter delivers that at most once: a Redis blip, or a replica that was not
 * subscribed at that instant, and the revoked user kept receiving every
 * position, every route event and every chat message of the company, for as
 * long as the tab stayed open. HTTP had refused them on the very next request.
 *
 * This is the rule both late checks share: the subscription handlers, which
 * ask it before joining a room, and the per-replica sweep, which asks it for
 * every local socket on a timer.
 */

/** What the handshake established about one connection. */
interface SocketSubject {
  userId: string;
  familyId: string;
  sessionVersion: number;
  role: string;
  businessId: string | null;
  driverId: string | null;
}

type SocketVerdict =
  | { keep: true; isDeliveryStaff: boolean }
  | { keep: false; reason: string };

/**
 * The `securityAction` reason each refusal is announced with.
 *
 * Picked from the reasons the clients already know: the web logs out on
 * `access_revoked`, `access_denied`, `user_updated`, `role_changed`,
 * `business_inactive`, `branch_inactive`, `driver_inactive` and
 * `no_permissions`, and re-checks `/user/me` on anything else; the app logs
 * out on anything but `permissions_changed`.
 * A server-side disconnect is final in socket.io-client, so a socket dropped
 * without a reason would just go quiet with the screen still open.
 */
const REASON_BY_ELIGIBILITY_CODE: Record<string, string> = {
  AUTH_ACCESS_REVOKED: "access_revoked",
  AUTH_BUSINESS_REQUIRED: "access_denied",
  // Their own reasons (decision 4.1): the app and the web word each one and
  // log out directly.
  AUTH_BUSINESS_INACTIVE: "business_inactive",
  AUTH_DRIVER_INACTIVE: "driver_inactive",
  AUTH_DRIVER_TENANT_MISMATCH: "driver_inactive",
  AUTH_BRANCH_INACTIVE: "branch_inactive",
  AUTH_PROFILE_NOT_CONFIGURED: "no_permissions",
};

const end = (reason: string): SocketVerdict => ({ keep: false, reason });

/**
 * The verdict for one connection, from rows read NOW.
 *
 * `familyActive` is optional because the subscription check does not read the
 * refresh family: a subscription only decides a room, and a dead family ends
 * the whole socket on the next sweep anyway.
 *
 * Deliberately NOT the access token's `exp`. The web keeps its socket open
 * with an expired `tkey` while a panel sits idle — the token is renewed by
 * navigating — and dropping on `exp` would disconnect every idle panel every
 * fifteen minutes, for good.
 */
async function judgeConnection(
  subject: SocketSubject,
  user: User | null,
  drivers: { findDriverById(driverId: string): Promise<Driver | null> },
  familyActive?: boolean,
): Promise<SocketVerdict> {
  if (!user) return end("access_denied");

  if ((user.session_version ?? 0) !== subject.sessionVersion) {
    return end("user_updated");
  }

  if (familyActive === false) return end("session_expired");

  // Role, company and driver link change without bumping the session version:
  // the edit fires `user_updated` and trusts the socket to die from it. If
  // that frame was lost, the socket is still acting on who the user WAS.
  if (
    user.role !== subject.role ||
    (user.businessId ?? null) !== subject.businessId ||
    (user.driverId ?? null) !== subject.driverId
  ) {
    return end("user_updated");
  }

  try {
    // The HTTP rule, not a copy of it: two implementations are two answers.
    await assertSessionEligible(user, drivers);
  } catch (error) {
    if (error instanceof AppError) {
      return end(REASON_BY_ELIGIBILITY_CODE[error.code] ?? "access_denied");
    }

    throw error;
  }

  return {
    keep: true,
    isDeliveryStaff: mayReadDeliveries({
      role: user.role,
      driverId: user.driverId,
      businessId: user.businessId,
      permissions: user.profileAccess?.permissions,
    }),
  };
}

/** Rows for many subjects at once: three queries per chunk, not per socket. */
interface SubjectRows {
  users: Map<string, User>;
  drivers: Map<string, Driver>;

  /** `${userId}:${familyId}` of every family still able to refresh. */
  activeFamilies: Set<string>;
}

/**
 * A few hundred sockets per replica is the ordinary case and tens of thousands
 * the planned one; an `IN` list stays well inside what Postgres plans well.
 */
const LOAD_CHUNK = 1_000;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];

  for (let index = 0; index < items.length; index += LOAD_CHUNK) {
    out.push(items.slice(index, index + LOAD_CHUNK));
  }

  return out;
}

async function loadSubjectRows(
  prisma: PrismaClient,
  subjects: SocketSubject[],
  now: Date = new Date(),
): Promise<SubjectRows> {
  const rows: SubjectRows = {
    users: new Map(),
    drivers: new Map(),
    activeFamilies: new Set(),
  };

  const userIds = [...new Set(subjects.map((subject) => subject.userId))];
  const familyIds = [...new Set(subjects.map((subject) => subject.familyId))];

  for (const ids of chunks(userIds)) {
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        role: true,
        access_revoked: true,
        session_version: true,
        businessId: true,
        driverId: true,
        business: { select: { is_active: true } },
        profileAccess: {
          select: {
            permissions: { select: { permissionKey: true, canRead: true } },
          },
        },
      },
    });

    // The eligibility rule reads a handful of fields; the rest of `User` is
    // not loaded, and nothing downstream reads it.
    for (const user of users) rows.users.set(user.id, user as unknown as User);
  }

  const driverIds = [
    ...new Set(
      [...rows.users.values()]
        .map((user) => user.driverId)
        .filter((driverId): driverId is string => Boolean(driverId)),
    ),
  ];

  for (const ids of chunks(driverIds)) {
    const drivers = await prisma.driver.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        status: true,
        businessId: true,
        branchId: true,
        branch: { select: { is_active: true } },
      },
    });

    for (const driver of drivers) {
      rows.drivers.set(driver.id, driver as unknown as Driver);
    }
  }

  for (const ids of chunks(familyIds)) {
    const families = await prisma.refreshToken.findMany({
      where: {
        family_id: { in: ids },
        revoked_at: null,
        expires_in: { gt: now },
      },
      select: { userId: true, family_id: true },
      distinct: ["family_id"],
    });

    for (const family of families) {
      rows.activeFamilies.add(`${family.userId}:${family.family_id}`);
    }
  }

  return rows;
}

/** The verdict for one subject, answered from rows loaded in bulk. */
function judgeFromRows(
  subject: SocketSubject,
  rows: SubjectRows,
): Promise<SocketVerdict> {
  return judgeConnection(
    subject,
    rows.users.get(subject.userId) ?? null,
    { findDriverById: async (id) => rows.drivers.get(id) ?? null },
    rows.activeFamilies.has(`${subject.userId}:${subject.familyId}`),
  );
}

/** The subject a socket's handshake recorded on `socket.data`. */
function subjectOf(data: Record<string, unknown>): SocketSubject {
  return {
    userId: String(data.userId),
    familyId: String(data.sessionId),
    sessionVersion: Number(data.sessionVersion),
    role: String(data.role),
    businessId: (data.businessId as string | null | undefined) ?? null,
    driverId: (data.driverId as string | null | undefined) ?? null,
  };
}

interface SweptSocket {
  connected: boolean;
  data: Record<string, unknown>;
}

interface SweepActions<S extends SweptSocket> {
  /** The session is over: announce it and drop the socket. */
  end(socket: S, reason: string): void;

  /** Still a session; its right to the dispatch rooms may have changed. */
  keep(socket: S, isDeliveryStaff: boolean): void;
}

interface SweepResult {
  checked: number;
  ended: number;

  /** The rows could not be read, so nobody was judged. */
  skipped: boolean;
}

/**
 * One pass over a replica's own sockets.
 *
 * Fails OPEN, the opposite of a room check, and on purpose. A server-side
 * disconnect is final in socket.io-client: a Postgres blip that dropped every
 * socket would leave the whole fleet without realtime until each person
 * reloaded. So a socket is ended only on a definitive negative answer — the
 * row says so — and a failed read leaves everyone for the next pass.
 */
async function sweepConnections<S extends SweptSocket>(
  sockets: S[],
  load: (subjects: SocketSubject[]) => Promise<SubjectRows>,
  actions: SweepActions<S>,
): Promise<SweepResult> {
  const authenticated = sockets.filter((socket) => socket.data.userId);

  if (authenticated.length === 0) {
    return { checked: 0, ended: 0, skipped: false };
  }

  let rows: SubjectRows;

  try {
    rows = await load(authenticated.map((socket) => subjectOf(socket.data)));
  } catch {
    return { checked: 0, ended: 0, skipped: true };
  }

  let ended = 0;

  for (const socket of authenticated) {
    // Gone while the rows were loading: nothing left to protect.
    if (!socket.connected) continue;

    let verdict: SocketVerdict;

    try {
      verdict = await judgeFromRows(subjectOf(socket.data), rows);
    } catch {
      continue;
    }

    if (verdict.keep) {
      actions.keep(socket, verdict.isDeliveryStaff);
      continue;
    }

    actions.end(socket, verdict.reason);
    ended += 1;
  }

  return { checked: authenticated.length, ended, skipped: false };
}

/**
 * ±25% around the configured interval.
 *
 * Every replica boots at the same moment in a deploy; without jitter they
 * would all sweep in the same second, forever.
 */
function jitteredInterval(baseMs: number, random: () => number = Math.random) {
  return Math.round(baseMs * (0.75 + random() * 0.5));
}

export {
  judgeConnection,
  judgeFromRows,
  jitteredInterval,
  loadSubjectRows,
  subjectOf,
  sweepConnections,
  REASON_BY_ELIGIBILITY_CODE,
};
export type {
  SocketSubject,
  SocketVerdict,
  SubjectRows,
  SweepActions,
  SweepResult,
  SweptSocket,
};

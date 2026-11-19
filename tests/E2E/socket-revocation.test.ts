import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { operationsRoom } from "@/shared/socket/operations-access";

import { socketClientEntry } from "./support/socket-client";
import {
  freePort,
  startReplica,
  type Replica,
} from "./support/replica-process";
import {
  emitHandled,
  waitForDisconnect,
  waitUntil,
} from "./support/socket-waits";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A revoked session, and the socket that did not hear about it.
 *
 * Every other socket test proves that a revocation ends a connection when the
 * frame announcing it arrives. This one is about the frame that does NOT: the
 * adapter delivers across replicas at most once, a replica's own disconnects
 * went through Redis too, and nothing ever looked at a live socket again after
 * its handshake. Each case here holds a session the database already
 * considers over — and asks whether the socket still hears the fleet.
 *
 *  - A permission removed on replica 1 for a dispatcher connected to replica
 *    2, who then re-subscribes on the same connection.
 *  - A MASTER demoted in the database, with no event at all, subscribing.
 *  - A refresh family revoked, a session version bumped, a permission removed
 *    — straight in the database, no event — against the periodic sweep.
 *  - A revocation issued on a replica whose Redis is down, for a socket on
 *    that same replica.
 *  - A revocation committed and announced while a handshake is still reading
 *    the database: the frame finds no room, because the socket joins its
 *    rooms only after the handshake ends.
 *  - A revocation written only by SQL, on a replica that never sweeps but
 *    reads the revocation feed (plano-escala F5-24): ended within 2 s.
 *
 * Every other replica here runs with the feed off (REVOCATION_FEED_POLL_MS
 * =0), so each case still proves the mechanism it names and not the feed.
 */
const prisma = createPrismaClient();

const CARRIER = "018fde00-0000-7000-8000-00000000000a";

const RESUBSCRIBER = "018fde00-0000-7000-8000-0000000000a1";
const MASTER = "018fde00-0000-7000-8000-0000000000a2";
const FAMILY_REVOKED = "018fde00-0000-7000-8000-0000000000a3";
const VERSION_BUMPED = "018fde00-0000-7000-8000-0000000000a4";
const PERMISSION_LOST = "018fde00-0000-7000-8000-0000000000a5";
const UNTOUCHED = "018fde00-0000-7000-8000-0000000000a6";
const ON_DEAD_REDIS = "018fde00-0000-7000-8000-0000000000a7";
const WITNESS = "018fde00-0000-7000-8000-0000000000a8";
const MID_HANDSHAKE_BUMPED = "018fde00-0000-7000-8000-0000000000a9";
const MID_HANDSHAKE_LOST = "018fde00-0000-7000-8000-0000000000aa";
const MID_HANDSHAKE_UNTOUCHED = "018fde00-0000-7000-8000-0000000000ab";
const FEED_BUMPED = "018fde00-0000-7000-8000-0000000000ac";
const FEED_FAMILY = "018fde00-0000-7000-8000-0000000000ad";
const FEED_UNTOUCHED = "018fde00-0000-7000-8000-0000000000ae";

const USERS = [
  RESUBSCRIBER,
  MASTER,
  FAMILY_REVOKED,
  VERSION_BUMPED,
  PERMISSION_LOST,
  UNTOUCHED,
  ON_DEAD_REDIS,
  WITNESS,
  MID_HANDSHAKE_BUMPED,
  MID_HANDSHAKE_LOST,
  MID_HANDSHAKE_UNTOUCHED,
  FEED_BUMPED,
  FEED_FAMILY,
  FEED_UNTOUCHED,
];

/** The sweeping replica's interval; the others effectively never sweep. */
const SWEEP_MS = 1_500;
const NEVER_MS = String(10 * 60 * 1000);

/** The other mechanisms, proven without the revocation feed. */
const FEED_OFF = "0";

const profiles: Record<string, string> = {};

const replicas: Replica[] = [];
let one: Replica;
let two: Replica;
let sweeper: Replica;
let isolated: Replica;

/** The handshakes held at their family read (see that describe). */
let held: Replica;

// Pub/Sub ignores the database number: this suite's replicas are kept
// apart from any other process on the same Redis by the channel prefix.
const SOCKET_ADAPTER_KEY = `socket.io-e2e-${randomUUID()}`;

const REDIS = process.env.REDIS_URL ?? "redis://localhost:6379";

interface TestSocket {
  id: string;
  on: Function;
  off: Function;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  emit: (...args: unknown[]) => unknown;
  disconnect: () => void;
  connected: boolean;
}

let connect: (url: string, options: unknown) => TestSocket;
const sockets: TestSocket[] = [];

function connectTo(port: number, token: string): Promise<TestSocket> {
  return new Promise((done, fail) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(
      () => fail(new Error(`o socket não conectou na porta ${port}`)),
      20_000,
    );

    socket.on("connect", () => {
      clearTimeout(timer);
      sockets.push(socket);
      done(socket);
    });

    socket.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
}

/**
 * A socket left to finish its handshake on its own, its listeners on before
 * it does: for a handshake the test holds in the middle. `heard` keeps every
 * `securityAction` from the first frame on.
 */
function openSocket(
  port: number,
  token: string,
): { socket: TestSocket; connected: Promise<void>; heard: unknown[] } {
  const socket = connect(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
  });

  sockets.push(socket);

  const heard: unknown[] = [];
  socket.on("securityAction", (payload: unknown) => heard.push(payload));

  const connected = new Promise<void>((done, fail) => {
    socket.once("connect", () => done());
    socket.once("connect_error", (error) => fail(error));
  });

  // Awaited after the hold; a refusal fails the test there, not as an
  // unhandled rejection while the lock is still taken.
  connected.catch(() => undefined);

  return { socket, connected, heard };
}

/**
 * Holds every read of refresh_token until `during` returns. A handshake's
 * last read is its family's, so it waits there with the user already read
 * and the socket in no room yet. Well inside the server's connectTimeout
 * (10 s), which counts the handshake too.
 */
async function holdingTheFamilyReads(
  during: () => Promise<void>,
): Promise<void> {
  let locked!: () => void;
  let release!: () => void;

  const lockTaken = new Promise<void>((done) => (locked = done));
  const released = new Promise<void>((done) => (release = done));

  const lock = prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `LOCK TABLE "refresh_token" IN ACCESS EXCLUSIVE MODE`,
      );
      locked();

      await released;
    },
    { maxWait: 10_000, timeout: 20_000 },
  );

  // A lock that failed says so, instead of leaving the test waiting.
  await Promise.race([lockTaken, lock]);

  try {
    await during();
  } finally {
    release();
    await lock;
  }
}

/**
 * Until `count` handshakes wait on that lock at their family read: the
 * `findFirst` of hasActiveRefreshTokenFamily, the one read of refresh_token
 * with a LIMIT. The sweep and the recheck after the join read it with a
 * `findMany` — and the sweeping replica's sweep is held by the lock too.
 */
function handshakesAtTheFamilyRead(count: number): Promise<void> {
  return waitUntil(
    async () => {
      const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS "waiting" FROM pg_stat_activity
        WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'
          AND "query" LIKE '%refresh_token%' AND "query" LIKE '%LIMIT%'
      `;

      return waiting >= count;
    },
    `${count} handshake(s) esperando na leitura da família`,
    8_000,
  );
}

/** Generous: a negative assertion is made out of this timeout. */
function waitFor(
  socket: TestSocket,
  event: string,
  timeoutMs = 4_000,
): Promise<Record<string, unknown> | null> {
  return new Promise((done) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      done(null);
    }, timeoutMs);

    const handler = (payload: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.off(event, handler);
      done(payload);
    };

    socket.on(event, handler);
  });
}

const position = () => ({
  driverId: "018fde00-0000-7000-8000-0000000000d1",
  routeId: "018fde00-0000-7000-8000-0000000000e1",
  latitude: -23.55,
  longitude: -46.63,
  speed: 30,
  heading: 90,
  recordedAt: new Date().toISOString(),
});

async function seedProfile(name: string): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name,
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: name,
            canRead: true,
            canWrite: false,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  return profile.id;
}

async function revokeProfile(profileId: string): Promise<void> {
  await prisma.permission.updateMany({
    where: { profileAccessId: profileId, permissionKey: "delivery_manage" },
    data: { canRead: false, canWrite: false },
  });
}

async function sessionFor(
  userId: string,
  role: string,
  businessId: string | null,
): Promise<{ token: string; familyId: string }> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const token = sign(
    {
      tokenType: "access",
      role,
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );

  return { token, familyId };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Revogação",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(62000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `revogacao-${randomUUID()}@exemplo.com.br`,
    },
  });

  for (const userId of USERS) {
    if (userId !== MASTER)
      profiles[userId] = await seedProfile(`Despacho ${userId.slice(-2)}`);
  }

  await prisma.user.createMany({
    data: USERS.map((id) => ({
      id,
      name: `Pessoa ${id.slice(-2)}`,
      email: `revogacao-${id.slice(-2)}-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: id === MASTER ? "MASTER" : "BUSINESS_USER",
      businessId: id === MASTER ? null : CARRIER,
      profileAccessId: id === MASTER ? null : profiles[id],
    })),
  });

  one = await startReplica({
    REDIS_URL: REDIS,
    SOCKET_ADAPTER_KEY,
    SOCKET_REVALIDATE_MS: NEVER_MS,
    REVOCATION_FEED_POLL_MS: FEED_OFF,
  });
  two = await startReplica({
    REDIS_URL: REDIS,
    SOCKET_ADAPTER_KEY,
    SOCKET_REVALIDATE_MS: NEVER_MS,
    REVOCATION_FEED_POLL_MS: FEED_OFF,
  });
  sweeper = await startReplica({
    REDIS_URL: REDIS,
    SOCKET_ADAPTER_KEY,
    SOCKET_REVALIDATE_MS: String(SWEEP_MS),
    REVOCATION_FEED_POLL_MS: FEED_OFF,
  });

  // Nothing listens on this port: Redis is down for this replica, and only
  // for it.
  isolated = await startReplica({
    REDIS_URL: `redis://127.0.0.1:${await freePort()}`,
    SOCKET_REVALIDATE_MS: NEVER_MS,
    REVOCATION_FEED_POLL_MS: FEED_OFF,
  });

  replicas.push(one, two, sweeper, isolated);

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));
}, 600_000);

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();

  await Promise.all(replicas.map((replica) => replica.stop()));

  await prisma.refreshToken.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
  await prisma.permission.deleteMany({
    where: { profileAccessId: { in: Object.values(profiles) } },
  });
  await prisma.profileAccess.deleteMany({
    where: { id: { in: Object.values(profiles) } },
  });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
}, 60_000);

describe("a permission removed on another replica", () => {
  it("does not come back with a subscribe on the same connection", async () => {
    const { token } = await sessionFor(RESUBSCRIBER, "BUSINESS_USER", CARRIER);
    const socket = await connectTo(two.port, token);

    await two.waitForRoom(socket.id, operationsRoom(CARRIER), true);

    // It IS in the room, across replicas, before anything happens.
    const before = waitFor(socket, "driverPosition");
    await one.run({
      kind: "driverPosition",
      businessId: CARRIER,
      payload: position(),
    });
    expect(await before, "o despachante não estava ouvindo").not.toBeNull();

    // The admin's edit lands on replica 1; the dispatcher is on replica 2.
    await revokeProfile(profiles[RESUBSCRIBER]);
    await one.run({
      kind: "securityToBusiness",
      businessId: CARRIER,
      payload: { reason: "permissions_changed" },
    });

    // Replica 2 re-reads the dispatcher and takes them out of the room.
    await two.waitForRoom(socket.id, operationsRoom(CARRIER), false);

    // What the control tower does on mount — or anybody, from the console.
    // Acknowledged once handled: refused, here, after the database read.
    await emitHandled(socket, "operationsSubscribe", { businessId: CARRIER });

    const after = waitFor(socket, "driverPosition");
    await one.run({
      kind: "driverPosition",
      businessId: CARRIER,
      payload: position(),
    });

    expect(
      await after,
      "voltou a ouvir a frota depois de perder a permissão",
    ).toBeNull();

    // Authorization changed, authentication did not: the connection stays.
    expect(socket.connected).toBe(true);
  }, 60_000);
});

describe("a MASTER demoted with no event at all", () => {
  it("cannot subscribe to a company, and the session ends", async () => {
    const { token } = await sessionFor(MASTER, "MASTER", null);
    const socket = await connectTo(two.port, token);

    await two.waitForRoom(socket.id, `user:${MASTER}`, true);

    // The edit whose `user_updated` frame never arrived.
    await prisma.user.update({
      where: { id: MASTER },
      data: { role: "BUSINESS_USER" },
    });

    // A deadline for the database read the subscribe makes, not a guess.
    const ended = waitFor(socket, "securityAction", 15_000);

    socket.emit("operationsSubscribe", { businessId: CARRIER });

    expect(await ended).toMatchObject({ reason: "user_updated" });

    const heard = waitFor(socket, "driverPosition");
    await one.run({
      kind: "driverPosition",
      businessId: CARRIER,
      payload: position(),
    });

    expect(await heard).toBeNull();
    expect(socket.connected).toBe(false);
  }, 60_000);
});

describe("the periodic sweep, with nothing announced", () => {
  it("ends what the database already ended, adjusts rooms, and leaves the rest alone", async () => {
    const familyRevoked = await sessionFor(
      FAMILY_REVOKED,
      "BUSINESS_USER",
      CARRIER,
    );
    const versionBumped = await sessionFor(
      VERSION_BUMPED,
      "BUSINESS_USER",
      CARRIER,
    );
    const permissionLost = await sessionFor(
      PERMISSION_LOST,
      "BUSINESS_USER",
      CARRIER,
    );
    const untouched = await sessionFor(UNTOUCHED, "BUSINESS_USER", CARRIER);

    const revokedSocket = await connectTo(sweeper.port, familyRevoked.token);
    const bumpedSocket = await connectTo(sweeper.port, versionBumped.token);
    const lostSocket = await connectTo(sweeper.port, permissionLost.token);
    const untouchedSocket = await connectTo(sweeper.port, untouched.token);

    for (const [socket, userId] of [
      [revokedSocket, FAMILY_REVOKED],
      [bumpedSocket, VERSION_BUMPED],
      [lostSocket, PERMISSION_LOST],
      [untouchedSocket, UNTOUCHED],
    ] as const) {
      await sweeper.waitForRoom(socket.id, `user:${userId}`, true);
    }

    // Generous deadlines for what must happen; the untouched socket's window
    // stays five sweeps — that one is a negative.
    const revokedEnd = waitFor(revokedSocket, "securityAction", 30_000);
    const bumpedEnd = waitFor(bumpedSocket, "securityAction", 30_000);
    const untouchedEnd = waitFor(
      untouchedSocket,
      "securityAction",
      SWEEP_MS * 5,
    );

    // Logged out elsewhere; password changed; profile edited — all straight
    // in the database, the way a lost frame looks from here.
    await prisma.refreshToken.updateMany({
      where: { family_id: familyRevoked.familyId },
      data: { revoked_at: new Date() },
    });
    await prisma.user.update({
      where: { id: VERSION_BUMPED },
      data: { session_version: { increment: 1 } },
    });
    await revokeProfile(profiles[PERMISSION_LOST]);

    expect(await revokedEnd).toMatchObject({ reason: "session_expired" });
    expect(await bumpedEnd).toMatchObject({ reason: "user_updated" });

    // A healthy session is never a casualty of the sweep.
    expect(await untouchedEnd).toBeNull();

    expect(revokedSocket.connected).toBe(false);
    expect(bumpedSocket.connected).toBe(false);
    expect(untouchedSocket.connected).toBe(true);

    // The permission loss is authorization: out of the room, still connected.
    // Its change was the last of the three written: a sweep that read between
    // the second and the third ended the others and kept this one for the
    // next pass. Waited for, rather than assumed done with the others.
    await sweeper.waitForRoom(lostSocket.id, operationsRoom(CARRIER), false);

    const lostHears = waitFor(lostSocket, "driverPosition");
    const untouchedHears = waitFor(untouchedSocket, "driverPosition");

    await one.run({
      kind: "driverPosition",
      businessId: CARRIER,
      payload: position(),
    });

    expect(await lostHears).toBeNull();
    expect(lostSocket.connected).toBe(true);
    expect(await untouchedHears).not.toBeNull();
  }, 90_000);
});

describe("a revocation while Redis is down", () => {
  it("still drops the socket on the replica that issued it", async () => {
    const { token } = await sessionFor(ON_DEAD_REDIS, "BUSINESS_USER", CARRIER);
    const socket = await connectTo(isolated.port, token);

    await isolated.waitForRoom(socket.id, `user:${ON_DEAD_REDIS}`, true);

    const announced = waitFor(socket, "securityAction");

    await isolated.run({
      kind: "securityToUser",
      businessId: CARRIER,
      payload: { userId: ON_DEAD_REDIS, reason: "access_revoked" },
    });

    expect(await announced).toMatchObject({ reason: "access_revoked" });

    await waitForDisconnect(socket).catch(() => undefined);

    expect(socket.connected, "o socket revogado continuou conectado").toBe(
      false,
    );
  }, 60_000);
});

describe("a revocation between the handshake's reads and its joins", () => {
  /**
   * The window is opened by holding the handshake's family read, so the
   * sockets here go to a replica on the old path (SESSION_LOOKUP_MODE=legacy,
   * plano-escala F4-05), which reads the family on its own, after the user.
   * The default path reads both in one statement, under one snapshot: a
   * lock taken before it delays the whole read, and a revocation committed
   * meanwhile is refused at the handshake itself
   * (session-statement-budget.test.ts proves each refusal in both modes).
   * What this proves, the recheck right after the joins, is the same code
   * in both modes; it covers the window that is left there, between the
   * read and the joins.
   */
  beforeAll(async () => {
    held = await startReplica({
      REDIS_URL: REDIS,
      SOCKET_ADAPTER_KEY,
      SOCKET_REVALIDATE_MS: NEVER_MS,
      REVOCATION_FEED_POLL_MS: FEED_OFF,
      SESSION_LOOKUP_MODE: "legacy",
    });

    replicas.push(held);
  }, 300_000);

  it("is caught right after the join, on a replica that never sweeps", async () => {
    // The held replica's own socket in the operation, connected before the
    // hold.
    const witness = await connectTo(
      held.port,
      (await sessionFor(WITNESS, "BUSINESS_USER", CARRIER)).token,
    );
    await held.waitForRoom(witness.id, operationsRoom(CARRIER), true);

    // Before the lock: a session is a refresh_token row.
    const bumpedSession = await sessionFor(
      MID_HANDSHAKE_BUMPED,
      "BUSINESS_USER",
      CARRIER,
    );
    const lostSession = await sessionFor(
      MID_HANDSHAKE_LOST,
      "BUSINESS_USER",
      CARRIER,
    );
    const untouchedSession = await sessionFor(
      MID_HANDSHAKE_UNTOUCHED,
      "BUSINESS_USER",
      CARRIER,
    );

    let bumped!: ReturnType<typeof openSocket>;
    let lost!: ReturnType<typeof openSocket>;
    let untouched!: ReturnType<typeof openSocket>;

    await holdingTheFamilyReads(async () => {
      bumped = openSocket(held.port, bumpedSession.token);
      lost = openSocket(held.port, lostSession.token);
      untouched = openSocket(held.port, untouchedSession.token);

      // Each has read its user (version 0, delivery_manage) and waits.
      await handshakesAtTheFamilyRead(3);

      // Committed, then announced from replica 1, the way an admin's edits
      // land: a session version bumped...
      await prisma.user.update({
        where: { id: MID_HANDSHAKE_BUMPED },
        data: { session_version: { increment: 1 } },
      });
      await one.run({
        kind: "securityToUser",
        businessId: CARRIER,
        payload: { userId: MID_HANDSHAKE_BUMPED, reason: "password_changed" },
      });

      // ...and a permission removed.
      await revokeProfile(profiles[MID_HANDSHAKE_LOST]);
      await one.run({
        kind: "securityToBusiness",
        businessId: CARRIER,
        payload: { reason: "permissions_changed" },
      });

      // The held replica's Redis subscription delivers in publish order: once its
      // witness hears a position published after both, both were handled
      // there — with the held sockets in no room to hear them.
      const witnessed = waitFor(witness, "driverPosition", 8_000);
      await one.run({
        kind: "driverPosition",
        businessId: CARRIER,
        payload: position(),
      });
      expect(
        await witnessed,
        "os avisos não passaram pela réplica retida antes do join",
      ).not.toBeNull();
    });

    await Promise.all([bumped.connected, lost.connected, untouched.connected]);

    // Before: connected with version 0 and in the company's dispatch rooms,
    // until a sweep this replica runs every ten minutes.
    await waitUntil(
      () => bumped.heard.length > 0,
      "a sessão encerrada ouvir o motivo",
    );
    expect(bumped.heard).toEqual([{ reason: "user_updated" }]);

    await waitForDisconnect(bumped.socket).catch(() => undefined);
    expect(bumped.socket.connected, "a sessão encerrada continuou").toBe(false);

    // The permission loss is authorization: out of the room, still connected.
    await held.waitForRoom(lost.socket.id, operationsRoom(CARRIER), false);

    const lostHears = waitFor(lost.socket, "driverPosition");
    const untouchedHears = waitFor(untouched.socket, "driverPosition");

    await one.run({
      kind: "driverPosition",
      businessId: CARRIER,
      payload: position(),
    });

    expect(await lostHears, "ouviu a frota sem a permissão").toBeNull();
    expect(lost.socket.connected).toBe(true);

    // Replica 1's permissions_changed found this socket in no room; the
    // recheck says it again, once, so the screen re-reads its permissions
    // instead of keeping the old menus over a feed gone quiet. Sent before
    // the socket left the rooms, so in by the end of the wait above.
    expect(lost.heard).toEqual([{ reason: "permissions_changed" }]);

    // A healthy session is never a casualty of the recheck.
    expect(await untouchedHears).not.toBeNull();
    expect(untouched.heard).toEqual([]);
    expect(untouched.socket.connected).toBe(true);
  }, 90_000);
});

/**
 * The revocation feed (plano-escala F5-24): a session ended only in the
 * database (no frame, no hint) on a replica that never sweeps. The
 * trigger's row reaches the replica's feed within its poll (1 s) and the
 * replica re-reads the sockets the row names after its settle (300 ms):
 * ended within 2 s of the commit, with the reason the sweep gives. The
 * session nobody touched stays.
 */
describe("a revocation written only by SQL, on a replica with the feed", () => {
  let feeding: Replica;

  beforeAll(async () => {
    feeding = await startReplica({
      REDIS_URL: REDIS,
      SOCKET_ADAPTER_KEY,
      SOCKET_REVALIDATE_MS: NEVER_MS,
      REVOCATION_FEED_POLL_MS: "1000",
    });

    replicas.push(feeding);
  }, 300_000);

  it("ends the socket within 2 s, and leaves the rest alone", async () => {
    const bumped = await sessionFor(FEED_BUMPED, "BUSINESS_USER", CARRIER);
    const family = await sessionFor(FEED_FAMILY, "BUSINESS_USER", CARRIER);
    const untouched = await sessionFor(
      FEED_UNTOUCHED,
      "BUSINESS_USER",
      CARRIER,
    );

    const bumpedSocket = await connectTo(feeding.port, bumped.token);
    const familySocket = await connectTo(feeding.port, family.token);
    const untouchedSocket = await connectTo(feeding.port, untouched.token);

    for (const [socket, userId] of [
      [bumpedSocket, FEED_BUMPED],
      [familySocket, FEED_FAMILY],
      [untouchedSocket, FEED_UNTOUCHED],
    ] as const) {
      await feeding.waitForRoom(socket.id, `user:${userId}`, true);
    }

    const bumpedEnd = waitFor(bumpedSocket, "securityAction", 10_000);
    const familyEnd = waitFor(familySocket, "securityAction", 10_000);
    const untouchedEnd = waitFor(untouchedSocket, "securityAction", 4_000);

    const committedAt = Date.now();

    await prisma.user.update({
      where: { id: FEED_BUMPED },
      data: { session_version: { increment: 1 } },
    });
    await prisma.refreshToken.deleteMany({
      where: { family_id: family.familyId },
    });

    expect(await bumpedEnd).toMatchObject({ reason: "user_updated" });
    expect(Date.now() - committedAt, "a revogação demorou").toBeLessThanOrEqual(
      2_000,
    );
    expect(await familyEnd).toMatchObject({ reason: "session_expired" });

    await waitForDisconnect(bumpedSocket).catch(() => undefined);
    await waitForDisconnect(familySocket).catch(() => undefined);

    expect(bumpedSocket.connected).toBe(false);
    expect(familySocket.connected).toBe(false);

    expect(await untouchedEnd).toBeNull();
    expect(untouchedSocket.connected).toBe(true);
  }, 90_000);
});

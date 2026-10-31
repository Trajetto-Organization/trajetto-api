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
import { emitHandled, waitForDisconnect } from "./support/socket-waits";
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

const USERS = [
  RESUBSCRIBER,
  MASTER,
  FAMILY_REVOKED,
  VERSION_BUMPED,
  PERMISSION_LOST,
  UNTOUCHED,
  ON_DEAD_REDIS,
];

/** The sweeping replica's interval; the others effectively never sweep. */
const SWEEP_MS = 1_500;
const NEVER_MS = String(10 * 60 * 1000);

const profiles: Record<string, string> = {};

const replicas: Replica[] = [];
let one: Replica;
let two: Replica;
let sweeper: Replica;
let isolated: Replica;

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

  const redis = process.env.REDIS_URL ?? "redis://localhost:6379";

  // Pub/Sub ignores the database number: this suite's replicas are kept
  // apart from any other process on the same Redis by the channel prefix.
  const SOCKET_ADAPTER_KEY = `socket.io-e2e-${randomUUID()}`;

  one = await startReplica({
    REDIS_URL: redis,
    SOCKET_ADAPTER_KEY,
    SOCKET_REVALIDATE_MS: NEVER_MS,
  });
  two = await startReplica({
    REDIS_URL: redis,
    SOCKET_ADAPTER_KEY,
    SOCKET_REVALIDATE_MS: NEVER_MS,
  });
  sweeper = await startReplica({
    REDIS_URL: redis,
    SOCKET_ADAPTER_KEY,
    SOCKET_REVALIDATE_MS: String(SWEEP_MS),
  });

  // Nothing listens on this port: Redis is down for this replica, and only
  // for it.
  isolated = await startReplica({
    REDIS_URL: `redis://127.0.0.1:${await freePort()}`,
    SOCKET_REVALIDATE_MS: NEVER_MS,
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

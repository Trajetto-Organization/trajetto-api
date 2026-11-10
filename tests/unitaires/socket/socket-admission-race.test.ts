import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import type { Server as SocketIOServer } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import auth from "@/config/auth";
import { chatStaffRoom } from "@/modules/chat/usecases/shared/chat-access-rules";
import { operationsRoom } from "@/shared/socket/operations-access";

import {
  waitForDisconnect,
  waitForRoom,
  waitUntil,
} from "../../E2E/support/socket-waits";

/**
 * A revocation that lands while a socket's handshake is still reading the
 * database — with the real Socket.IO server, in this process.
 *
 * The handshake reads the user, then the refresh family, and only after
 * `next()` and a nextTick does the socket join its rooms. Every revocation
 * commits and THEN announces itself to those rooms (ADR 0007), so one
 * committed between the reads and the join told nobody: the socket connected
 * with the rights it had before — the web's dispatch rooms included — and
 * kept them until the periodic sweep, up to 225 s later. The sweep never runs
 * in this file, so whatever ends a socket here is the recheck right after the
 * join.
 *
 * The repositories and the database are fakes reading one mutable state. The
 * family read — the handshake's last — is held open, the revocation happens
 * while it waits, and only then is it let go: exactly the window, on demand.
 */
const fake = vi.hoisted(() => {
  // Never during this file: what ends a socket must be the admission recheck.
  process.env.SOCKET_REVALIDATE_MS = String(60 * 60 * 1000);

  // Pub/Sub ignores the Redis database number: a channel prefix of its own
  // keeps these emits away from a development API sharing the same Redis.
  process.env.SOCKET_ADAPTER_KEY = `socket.io-unit-${globalThis.crypto.randomUUID()}`;

  interface Person {
    session_version: number;
    canReadDeliveries: boolean;
  }

  const people = new Map<string, Person>();
  const families = new Set<string>();

  /** The handshakes held at their family read, by user. */
  const gates = new Map<
    string,
    { reached: () => void; released: Promise<void> }
  >();

  const CARRIER = "018fde00-0000-7000-8000-00000000c0a1";

  const familyOf = (userId: string) => `family-${userId}`;

  /** The user as UserRepository.findUserById returns it to the handshake. */
  function sessionUser(userId: string) {
    const person = people.get(userId);

    if (!person) return null;

    return {
      id: userId,
      name: `Pessoa ${userId.slice(-2)}`,
      email: `${userId}@exemplo.com.br`,
      password: "",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      access_revoked: false,
      session_version: person.session_version,
      business: { is_active: true, entitlements: [] },
      profileAccess: {
        name: "Despacho",
        permissions: [
          {
            id: `permission-${userId}`,
            permissionKey: "delivery_manage",
            action: "Despacho",
            canRead: person.canReadDeliveries,
            canWrite: false,
          },
        ],
      },
      driver: null,
    };
  }

  return { CARRIER, people, families, gates, familyOf, sessionUser };
});

vi.mock("@/modules/user/repositories/user-repository", () => ({
  UserRepository: class {
    async findUserById(userId: string) {
      return fake.sessionUser(userId);
    }
  },
}));

vi.mock("@/modules/user/repositories/user-tokens-repository", () => ({
  UserTokensRepository: class {
    /**
     * Answers what is true NOW, when the query would run, and hands the
     * answer back only once the test lets go: the window between the
     * handshake's reads and its joins, held open.
     */
    async hasActiveRefreshTokenFamily(userId: string, familyId: string) {
      const active = fake.families.has(familyId);
      const gate = fake.gates.get(userId);

      if (gate) {
        gate.reached();
        await gate.released;
      }

      return active;
    }

    async revokeUserRefreshTokenFamily() {}
  },
}));

vi.mock("@/modules/driver/repositories/driver-repository", () => ({
  DriverRepository: class {
    async findDriverById() {
      return null;
    }
  },
}));

// The bulk read the recheck and the sweep share (loadSubjectRows).
vi.mock("@/../infra/database", () => ({
  default: {
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => {
          const user = fake.sessionUser(id);

          return user ? [user] : [];
        }),
      update: async () => ({}),
    },
    driver: { findMany: async () => [] },
    refreshToken: {
      findMany: async ({ where }: { where: { family_id: { in: string[] } } }) =>
        where.family_id.in
          .filter((familyId) => fake.families.has(familyId))
          .map((familyId) => ({
            userId: familyId.slice("family-".length),
            family_id: familyId,
          })),
    },
  },
}));

// No Redis bucket shared with other suites: every handshake is allowed.
vi.mock("@/shared/socket/handshake-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/shared/socket/handshake-rate-limit")
  >()),
  createHandshakeLimiter: () => ({ allow: async () => true }),
}));

const { CARRIER } = fake;

const HEALTHY = "018fde00-0000-7000-8000-00000000c0b1";
const VERSION_BUMPED = "018fde00-0000-7000-8000-00000000c0b2";
const LOGGED_OUT = "018fde00-0000-7000-8000-00000000c0b3";
const PERMISSION_LOST = "018fde00-0000-7000-8000-00000000c0b4";

let server: Server;
let port = 0;
let websocket: typeof import("@/websocket");
let io: SocketIOServer;

const clients: ClientSocket[] = [];

function seed(userId: string): void {
  fake.people.set(userId, { session_version: 0, canReadDeliveries: true });
  fake.families.add(fake.familyOf(userId));
}

/** Holds this user's next handshake at its family read until released. */
function holdHandshake(userId: string) {
  let reached!: () => void;
  let release!: () => void;

  const atFamilyRead = new Promise<void>((done) => (reached = done));
  const released = new Promise<void>((done) => (release = done));

  fake.gates.set(userId, { reached, released });

  return { atFamilyRead, release };
}

/** A web socket (no app marker), every listener on before it connects. */
function open(userId: string) {
  const token = sign(
    {
      tokenType: "access",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      sessionVersion: 0,
      familyId: fake.familyOf(userId),
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );

  const socket = connect(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
  });

  clients.push(socket);

  const heard = {
    securityAction: [] as unknown[],
    driverPosition: [] as unknown[],
  };

  socket.on("securityAction", (payload: unknown) =>
    heard.securityAction.push(payload),
  );
  socket.on("driverPosition", (payload: unknown) =>
    heard.driverPosition.push(payload),
  );

  const connected = new Promise<void>((done, fail) => {
    socket.once("connect", () => done());
    socket.once("connect_error", fail);
  });

  // Awaited only where the test needs it; a refusal elsewhere fails the
  // test through what it waits on, not as an unhandled rejection.
  connected.catch(() => undefined);

  return { socket, heard, connected };
}

/**
 * What "right after the join" is given on a loaded runner. The recheck takes
 * milliseconds; without it, nothing here would end a socket for an hour.
 */
const DEADLINE_MS = 5_000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_done, fail) =>
      setTimeout(() => fail(new Error(`tempo esgotado: ${what}`)), ms),
    ),
  ]);
}

const position = () => ({
  driverId: "018fde00-0000-7000-8000-00000000c0d1",
  routeId: "018fde00-0000-7000-8000-00000000c0e1",
  latitude: -23.55,
  longitude: -46.63,
  speed: 30,
  heading: 90,
  recordedAt: new Date().toISOString(),
});

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;

  websocket = await import("@/websocket");

  io = await websocket.initializeSocketIO(server);
}, 30_000);

afterEach(() => {
  for (const socket of clients.splice(0)) socket.disconnect();

  fake.gates.clear();
});

afterAll(async () => {
  websocket?.closeRealtimeConnections();
  await websocket?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));
});

describe("a revocation while the handshake reads the database", () => {
  it("ends the session right after the join, and leaves a healthy one alone", async () => {
    for (const userId of [HEALTHY, VERSION_BUMPED, LOGGED_OUT]) seed(userId);

    const healthyHold = holdHandshake(HEALTHY);
    const bumpedHold = holdHandshake(VERSION_BUMPED);
    const loggedOutHold = holdHandshake(LOGGED_OUT);

    const healthy = open(HEALTHY);
    const bumped = open(VERSION_BUMPED);
    const loggedOut = open(LOGGED_OUT);

    // All three have read the user and wait on the family: the window.
    await Promise.all([
      healthyHold.atFamilyRead,
      bumpedHold.atFamilyRead,
      loggedOutHold.atFamilyRead,
    ]);

    // Committed, then announced, the way the use cases do it. A password
    // change bumps the version; a logout revokes the family.
    fake.people.get(VERSION_BUMPED)!.session_version = 1;
    websocket.sendSecurityEventToUser(VERSION_BUMPED, {
      reason: "password_changed",
    });

    fake.families.delete(fake.familyOf(LOGGED_OUT));
    websocket.sendSecurityEventToSession(fake.familyOf(LOGGED_OUT), {
      reason: "logout",
    });

    // Neither announcement had anyone to reach.
    const rooms = io.of("/").adapter.rooms;
    expect(rooms.get(`user:${VERSION_BUMPED}`)).toBeUndefined();
    expect(rooms.get(`session:${fake.familyOf(LOGGED_OUT)}`)).toBeUndefined();

    // The healthy one first: one queue per replica, in order, so its verdict
    // is in by the time the revoked ones are ended.
    healthyHold.release();
    await within(healthy.connected, DEADLINE_MS, "o socket saudável conectar");

    bumpedHold.release();
    loggedOutHold.release();

    // Before: both connected, in their company's dispatch rooms, hearing
    // every truck until the sweep.
    await within(
      Promise.all([bumped.connected, loggedOut.connected]),
      DEADLINE_MS,
      "os sockets revogados conectarem",
    );
    await waitForDisconnect(bumped.socket, DEADLINE_MS);
    await waitForDisconnect(loggedOut.socket, DEADLINE_MS);

    // Told why, in the reasons both clients turn into a logout.
    expect(bumped.heard.securityAction).toEqual([{ reason: "user_updated" }]);
    expect(loggedOut.heard.securityAction).toEqual([
      { reason: "session_expired" },
    ]);

    // A healthy session is never a casualty of the recheck.
    expect(healthy.socket.connected).toBe(true);
    expect(healthy.heard.securityAction).toEqual([]);
    expect(rooms.get(operationsRoom(CARRIER))?.has(healthy.socket.id!)).toBe(
      true,
    );

    websocket.sendDriverPositionToBusiness(CARRIER, position());

    await waitUntil(
      () => healthy.heard.driverPosition.length === 1,
      "o socket saudável ouvir a posição",
      DEADLINE_MS,
    );
  });

  it("takes a socket whose permission went meanwhile out of dispatch and tells it, connection kept", async () => {
    seed(PERMISSION_LOST);

    const hold = holdHandshake(PERMISSION_LOST);
    const lost = open(PERMISSION_LOST);

    await hold.atFamilyRead;

    // The handshake already decided "dispatch staff" from the profile it
    // read; the admin removes delivery_manage before the join.
    fake.people.get(PERMISSION_LOST)!.canReadDeliveries = false;
    websocket.sendSecurityEventToBusiness(CARRIER, {
      reason: "permissions_changed",
    });

    hold.release();
    await within(lost.connected, DEADLINE_MS, "o socket conectar");

    // The web joins its company's dispatch rooms at connect; the recheck
    // takes it back out. Before, it stayed until the sweep.
    await waitForRoom(
      io,
      lost.socket.id!,
      operationsRoom(CARRIER),
      false,
      DEADLINE_MS,
    );
    await waitForRoom(
      io,
      lost.socket.id!,
      chatStaffRoom(CARRIER),
      false,
      DEADLINE_MS,
    );

    // A position, then a nudge on the same connection: frames arrive in
    // order, so once the nudge is in, the position would have been too.
    const nudged = new Promise<void>((done) =>
      lost.socket.once("pushNotification", () => done()),
    );

    websocket.sendDriverPositionToBusiness(CARRIER, position());
    websocket.sendNotificationToUser(PERMISSION_LOST, { title: "marcador" });

    await within(nudged, DEADLINE_MS, "o socket ouvir o aviso");

    expect(lost.heard.driverPosition).toEqual([]);

    // Authorization changed, authentication did not. The company's
    // permissions_changed reached no room this socket was in; it hears the
    // recheck's, once — sent before the nudge, so already in — and keeps its
    // session: the web re-reads /user/me on it, instead of a screen with the
    // old menus over a feed gone quiet.
    expect(lost.socket.connected).toBe(true);
    expect(lost.heard.securityAction).toEqual([
      { reason: "permissions_changed" },
    ]);
  });
});

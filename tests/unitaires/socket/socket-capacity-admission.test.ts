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

import { waitUntil } from "../../E2E/support/socket-waits";

/**
 * The admission of the real Socket.IO server (plano-escala U-01, F2.19):
 * the two ceilings refuse with the wait the clients honour, and a capacity
 * refusal is never charged to the address. A user over their own budget or
 * sockets is: given back, one valid token looped handshakes from one
 * address with no bound once its own budget ran out.
 *
 * Every connection here comes from 127.0.0.1, which is exactly the case the
 * change is for: hundreds of drivers behind one CGNAT reconnecting during a
 * deploy, while a replica is full. Counted by attempt, as the address budget
 * was, the 301st was locked out for the rest of the minute by colleagues
 * that did nothing wrong. The limiter is a recording fake, so the test asks
 * only what the server charges and gives back, with no Redis bucket shared
 * with other suites; the scripts themselves run against a real Redis in
 * tests/E2E/socket-handshake-window.test.ts.
 */
const fake = vi.hoisted(() => {
  // Two handshakes at once and four sockets: small enough to fill by hand.
  process.env.SOCKET_HANDSHAKE_MAX_INFLIGHT = "2";
  process.env.SOCKET_MAX_CONNECTIONS = "4";

  // Never during this file.
  process.env.SOCKET_REVALIDATE_MS = String(60 * 60 * 1000);

  // Pub/Sub ignores the Redis database number: a prefix of its own.
  process.env.SOCKET_ADAPTER_KEY = `socket.io-unit-${globalThis.crypto.randomUUID()}`;

  const CARRIER = "018fdf00-0000-7000-8000-00000000c0a1";

  const families = new Set<string>();

  /** The handshakes held at their family read, by user. */
  const gates = new Map<
    string,
    { reached: () => void; released: Promise<void> }
  >();

  const limiter = {
    allowed: [] as string[],
    refunded: [] as string[],

    /** Users whose own budget is spent: their bucket refuses. */
    spentUsers: new Set<string>(),
  };

  /** Sockets one user may hold here; the real 20 unless a case lowers it. */
  const perUser = { max: 20 };

  const familyOf = (userId: string) => `family-${userId}`;

  function sessionUser(userId: string) {
    return {
      id: userId,
      name: `Pessoa ${userId.slice(-2)}`,
      email: `${userId}@exemplo.com.br`,
      password: "",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      access_revoked: false,
      session_version: 0,
      business: { is_active: true, entitlements: [] },
      profileAccess: {
        name: "Despacho",
        permissions: [
          {
            id: `permission-${userId}`,
            permissionKey: "delivery_manage",
            action: "Despacho",
            canRead: true,
            canWrite: false,
          },
        ],
      },
      driver: null,
    };
  }

  return { CARRIER, families, gates, limiter, perUser, familyOf, sessionUser };
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
    /** Held open on demand: a handshake in flight, for as long as needed. */
    async hasActiveRefreshTokenFamily(userId: string, familyId: string) {
      const gate = fake.gates.get(userId);

      if (gate) {
        gate.reached();
        await gate.released;
      }

      return fake.families.has(familyId);
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

// The bulk read of the admission recheck (loadSubjectRows).
vi.mock("@/../infra/database", () => ({
  default: {
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => fake.sessionUser(id)),
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

vi.mock("@/shared/socket/handshake-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/shared/socket/handshake-rate-limit")
  >()),
  // Read at each handshake, so a case can lower it.
  get SOCKET_MAX_CONNECTIONS_PER_USER() {
    return fake.perUser.max;
  },
  createHandshakeLimiter: () => ({
    allow: async (key: string) => {
      if (key.startsWith("socket-handshake:ip")) fake.limiter.allowed.push(key);

      const user = /^socket-handshake:user:(.+)$/.exec(key)?.[1];

      return !(user && fake.limiter.spentUsers.has(user));
    },
    refund: async (key: string) => {
      fake.limiter.refunded.push(key);
    },
  }),
}));

const { CARRIER } = fake;

const FIRST = "018fdf00-0000-7000-8000-00000000c0b1";
const SECOND = "018fdf00-0000-7000-8000-00000000c0b2";
const THIRD = "018fdf00-0000-7000-8000-00000000c0b3";

let server: Server;
let port = 0;
let websocket: typeof import("@/websocket");
let io: SocketIOServer;

const clients: ClientSocket[] = [];

function tokenFor(userId: string, secret = auth.secret_token): string {
  return sign(
    {
      tokenType: "access",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      sessionVersion: 0,
      familyId: fake.familyOf(userId),
    },
    secret,
    { subject: userId, expiresIn: "1h" },
  );
}

type Refusal = Error & { data?: { code?: string; retryAfterMs?: number } };

/** A socket and how its handshake ended: connected, or the refusal. */
function open(
  userId: string,
  options: { token?: string; mobile?: boolean } = {},
) {
  fake.families.add(fake.familyOf(userId));

  const socket = connect(`http://127.0.0.1:${port}`, {
    auth: { token: options.token ?? tokenFor(userId) },
    transports: ["websocket"],
    reconnection: false,
    ...(options.mobile
      ? { extraHeaders: { "x-trajetto-client": "mobile" } }
      : {}),
  });

  clients.push(socket);

  const outcome = new Promise<Refusal | null>((done) => {
    socket.once("connect", () => done(null));
    socket.once("connect_error", (error) => done(error as Refusal));
  });

  return { socket, outcome };
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

const ADDRESS = "socket-handshake:ip:127.0.0.1";

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;

  websocket = await import("@/websocket");

  io = await websocket.initializeSocketIO(server);
}, 30_000);

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.disconnect();

  fake.gates.clear();

  // Each case starts from an empty replica: the ceilings count what is here.
  await waitUntil(
    () => io.engine.clientsCount === 0,
    "os sockets do caso anterior saírem",
  );

  fake.limiter.allowed.length = 0;
  fake.limiter.refunded.length = 0;
  fake.limiter.spentUsers.clear();
  fake.perUser.max = 20;
});

afterAll(async () => {
  websocket?.closeRealtimeConnections();
  await websocket?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));
});

describe("the in-flight ceiling", () => {
  it("refuses the handshake past it with the wait, and gives its address back", async () => {
    const firstHold = holdHandshake(FIRST);
    const secondHold = holdHandshake(SECOND);

    const first = open(FIRST);
    const second = open(SECOND);

    // Two handshakes waiting on the database: the ceiling.
    await Promise.all([firstHold.atFamilyRead, secondHold.atFamilyRead]);

    const refusal = await open(THIRD).outcome;

    expect(refusal?.data?.code).toBe("SOCKET_UNAVAILABLE");
    expect(refusal?.data?.retryAfterMs).toBeGreaterThanOrEqual(5_000);
    expect(refusal?.data?.retryAfterMs).toBeLessThan(10_000);

    // Charged at the engine, given back: a full replica is nobody's fault.
    await waitUntil(
      () => fake.limiter.refunded.length === 1,
      "a recusa devolver a tentativa ao endereço",
    );
    expect(fake.limiter.refunded).toEqual([ADDRESS]);

    expect(websocket.realtimeMetrics().handshakes.refused.inflight).toBe(1);

    firstHold.release();
    secondHold.release();

    // The two that held the passes connect, and give theirs back too.
    expect(await first.outcome).toBeNull();
    expect(await second.outcome).toBeNull();

    await waitUntil(
      () => fake.limiter.refunded.length === 3,
      "as duas admitidas devolverem a tentativa",
    );
    expect(fake.limiter.allowed).toHaveLength(3);
  });
});

describe("the socket ceiling", () => {
  it("refuses the fifth socket of four with the wait, not charged", async () => {
    for (let index = 0; index < 4; index += 1) {
      expect(await open(FIRST).outcome).toBeNull();
    }

    const refusal = await open(SECOND).outcome;

    expect(refusal?.data?.code).toBe("SOCKET_UNAVAILABLE");
    expect(refusal?.data?.retryAfterMs).toBeGreaterThanOrEqual(5_000);

    await waitUntil(
      () => fake.limiter.refunded.length === 5,
      "as quatro admitidas e a recusa devolverem a tentativa",
    );

    expect(websocket.realtimeMetrics().handshakes.refused.connections).toBe(1);
  });
});

describe("a credential failure", () => {
  it("keeps the attempt on the address", async () => {
    const refusal = await open(FIRST, {
      token: tokenFor(FIRST, "outro-segredo-que-nao-e-o-da-api-0123456789"),
    }).outcome;

    expect(refusal?.data?.code).toBe("AUTH_TOKEN_INVALID");

    // Guessing tokens is what the address budget is for.
    expect(fake.limiter.allowed).toEqual([ADDRESS]);
    expect(fake.limiter.refunded).toEqual([]);

    expect(
      websocket.realtimeMetrics().handshakes.refused.credential,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("a user over their own limits", () => {
  it("keeps the attempt on the address once the user's budget is spent", async () => {
    fake.limiter.spentUsers.add(FIRST);

    // One valid token looping handshakes from one address: given back, the
    // address never reached its 300 a minute and nothing cut it off.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refusal = await open(FIRST).outcome;

      expect(refusal?.data?.code).toBe("SOCKET_RATE_LIMITED");
    }

    expect(fake.limiter.allowed).toEqual([ADDRESS, ADDRESS, ADDRESS]);
    expect(fake.limiter.refunded).toEqual([]);
    expect(
      websocket.realtimeMetrics().handshakes.refused.rate_limited,
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps it for the socket past the user's own ceiling, after the reads", async () => {
    fake.perUser.max = 1;

    expect(await open(FIRST).outcome).toBeNull();

    const refusal = await open(FIRST).outcome;

    expect(refusal?.data?.code).toBe("SOCKET_TOO_MANY_CONNECTIONS");

    // The admitted one gave its attempt back; the refused one did not. Each
    // refund is queued before the handshake answers, so both are known.
    expect(fake.limiter.allowed).toEqual([ADDRESS, ADDRESS]);
    expect(fake.limiter.refunded).toEqual([ADDRESS]);
  });
});

describe("the upgrade's request", () => {
  it("is let go once connected, and the app is still told apart from the web", async () => {
    const app = open(FIRST, { mobile: true });
    const web = open(SECOND);

    expect(await app.outcome).toBeNull();
    expect(await web.outcome).toBeNull();

    const serverSide = (id: string | undefined) =>
      io.of("/").sockets.get(String(id));

    // Kept for the socket's whole life, read by nothing after the handshake.
    expect(
      (serverSide(app.socket.id)?.conn as unknown as { request: unknown })
        .request,
    ).toBeNull();

    // The marker header the rooms depend on was taken before letting go.
    expect(serverSide(app.socket.id)?.data.client).toBe("mobile");
    expect(serverSide(web.socket.id)?.data.client).toBe("web");
  });
});

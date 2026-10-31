import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import type { Server as SocketIOServer } from "socket.io";

import auth from "@/config/auth";

import {
  chatDriverRoom,
  chatStaffRoom,
} from "@/modules/chat/usecases/shared/chat-access-rules";
import { HINT_BURST, HINT_REFILL_MS } from "@/shared/socket/hint-throttle";

import { socketClientEntry } from "./support/socket-client";
import { waitForRoom, waitUntil } from "./support/socket-waits";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Chat hints and presence, through the real server.
 *
 * - "Digitando"/"gravando" were relayed on every frame. A driver token in a
 *   loop fanned each one out to every SAC panel of the company; a staff token
 *   put a cluster-wide `fetchSockets` through Redis per frame, with a room
 *   name the client wrote.
 * - The thread list's presence fetched every socket of the company, and each
 *   answer carried the socket's handshake — its access token included.
 */
const prisma = createPrismaClient();

const CARRIER = "018fd000-0000-7000-8000-0000000c4a01";
const OTHER_CARRIER = "018fd000-0000-7000-8000-0000000c4a02";

const STAFF = "018fd000-0000-7000-8000-0000000c4a11";
const DRIVER_USER = "018fd000-0000-7000-8000-0000000c4a12";
const OTHER_DRIVER_USER = "018fd000-0000-7000-8000-0000000c4a13";

const DRIVER = "018fd000-0000-7000-8000-0000000c4a21";
const OTHER_DRIVER = "018fd000-0000-7000-8000-0000000c4a22";

interface TestSocket {
  id: string;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler: (...args: any[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  disconnect: () => void;
}

let server: Server;
let port = 0;

let io: typeof import("@/websocket");
let ioServer: SocketIOServer;

let profileId = "";

/**
 * Cluster-wide `fetchSockets` calls still in flight. A driver's connection
 * asks the cluster whether they were already online (presence), and on a
 * shared Redis that question can wait the adapter's timeout for other nodes
 * before falling back to this replica's own view — a second call. A case
 * that counts fetches starts after those, not in the middle of them.
 */
let fetchesInFlight = 0;

let staff: TestSocket;
let driver: TestSocket;
let otherDriver: TestSocket;

let connect: (url: string, options: unknown) => TestSocket;

function connectAs(token: string): Promise<TestSocket> {
  return new Promise((done, reject) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(() => reject(new Error("timeout")), 10_000);

    socket.on("connect", () => {
      clearTimeout(timer);
      done(socket);
    });

    socket.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Every copy of an event that must arrive: waits for the first however long
 * it takes, then keeps listening `quietMs` for a second one. A fixed window
 * read a first copy slower than the window as none.
 */
async function arrivals(
  socket: TestSocket,
  event: string,
  send: () => void,
  quietMs = 500,
): Promise<unknown[]> {
  const received: unknown[] = [];
  const handler = (payload: unknown) => received.push(payload);

  socket.on(event, handler);

  try {
    send();

    await waitUntil(() => received.length > 0, `${event} chegar`);
    await new Promise((done) => setTimeout(done, quietMs));
  } finally {
    socket.off(event, handler);
  }

  return received;
}

/** Counts one event on a socket for a while: what a "never" is made of. */
function count(socket: TestSocket, event: string, forMs: number) {
  return new Promise<unknown[]>((done) => {
    const received: unknown[] = [];
    const handler = (payload: unknown) => received.push(payload);

    socket.on(event, handler);

    setTimeout(() => {
      socket.off(event, handler);
      done(received);
    }, forMs);
  });
}

async function tokenFor(
  userId: string,
  businessId: string,
  driverId: string | null,
): Promise<string> {
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

  return sign(
    {
      tokenType: "access",
      role: "BUSINESS_USER",
      businessId,
      driverId,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

async function seedBusiness(id: string, label: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: label,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `${Date.now()}${Math.floor(Math.random() * 10)}`.slice(-14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `dicas-${randomUUID()}@exemplo.com.br`,
    },
  });
}

async function seedDriver(id: string, businessId: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-4)}`,
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-11),
      rg: randomUUID().slice(0, 9),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

beforeAll(async () => {
  await seedBusiness(CARRIER, "Transportadora das Dicas");
  await seedBusiness(OTHER_CARRIER, "Transportadora Vizinha das Dicas");

  await seedDriver(DRIVER, CARRIER);
  await seedDriver(OTHER_DRIVER, OTHER_CARRIER);

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Atendimento",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Gerenciar entregas",
            canRead: true,
            canWrite: true,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  profileId = profile.id;

  await prisma.user.createMany({
    data: [
      {
        id: STAFF,
        name: "Atendente",
        email: `atendente-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: profile.id,
      },
      {
        id: DRIVER_USER,
        name: "Motorista",
        email: `motorista-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId: DRIVER,
      },
      {
        id: OTHER_DRIVER_USER,
        name: "Motorista Vizinho",
        email: `vizinho-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: OTHER_CARRIER,
        driverId: OTHER_DRIVER,
      },
    ],
  });

  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;

  io = await import("@/websocket");
  ioServer = await io.initializeSocketIO(server);

  const adapter = ioServer.of("/").adapter;
  const fetchSockets = adapter.fetchSockets.bind(adapter);

  adapter.fetchSockets = ((options: Parameters<typeof fetchSockets>[0]) => {
    fetchesInFlight += 1;

    return fetchSockets(options).finally(() => {
      fetchesInFlight -= 1;
    });
  }) as typeof adapter.fetchSockets;

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));

  staff = await connectAs(await tokenFor(STAFF, CARRIER, null));
  driver = await connectAs(await tokenFor(DRIVER_USER, CARRIER, DRIVER));
  otherDriver = await connectAs(
    await tokenFor(OTHER_DRIVER_USER, OTHER_CARRIER, OTHER_DRIVER),
  );

  // In the rooms the hints are addressed to, as the server records them —
  // not 1.5 s after the handshake.
  await waitForRoom(ioServer, staff.id, chatStaffRoom(CARRIER), true);
  await waitForRoom(
    ioServer,
    driver.id,
    chatDriverRoom(CARRIER, DRIVER_USER),
    true,
  );
  await waitForRoom(
    ioServer,
    otherDriver.id,
    chatDriverRoom(OTHER_CARRIER, OTHER_DRIVER_USER),
    true,
  );
}, 180_000);

afterAll(async () => {
  for (const socket of [staff, driver, otherDriver]) socket?.disconnect();

  await io?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));

  const users = [STAFF, DRIVER_USER, OTHER_DRIVER_USER];

  await prisma.refreshToken.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.driver.deleteMany({
    where: { id: { in: [DRIVER, OTHER_DRIVER] } },
  });
  await prisma.permission.deleteMany({ where: { profileAccessId: profileId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileId } });
  await prisma.business.deleteMany({
    where: { id: { in: [CARRIER, OTHER_CARRIER] } },
  });

  await prisma.$disconnect();
});

describe("a driver's typing hint in a loop", () => {
  it("reaches the SAC a handful of times, not a thousand", async () => {
    const started = Date.now();

    const hints = await arrivals(
      staff,
      "chatTyping",
      () => {
        for (let frame = 0; frame < 1_000; frame += 1) {
          driver.emit("chatTyping");
        }
      },
      1_000,
    );

    // The bucket's own arithmetic over the time the flood took: the burst,
    // then one per refill. Against the clock that actually passed, so a slow
    // machine is held to the same rule instead of a number tuned on a fast
    // one.
    const allowed =
      HINT_BURST + Math.ceil((Date.now() - started) / HINT_REFILL_MS);

    expect(hints.length).toBeGreaterThan(0);
    expect(hints.length).toBeLessThanOrEqual(allowed);
    expect(allowed).toBeLessThan(100);
  });
});

describe("a staff typing hint", () => {
  it("never costs a cluster-wide fetch", { timeout: 30_000 }, async () => {
    const adapter = ioServer.of("/").adapter;

    // The presence questions of the connections above are not this case's.
    await waitUntil(
      () => fetchesInFlight === 0,
      "as consultas de presença das conexões terminarem",
    );

    const fetches = vi.spyOn(adapter, "fetchSockets");

    try {
      // A full bucket for the staff socket: time passing is the refill, not
      // a guess at how long the server takes.
      await new Promise((done) =>
        setTimeout(done, (HINT_BURST + 1) * HINT_REFILL_MS),
      );

      const reached = await arrivals(driver, "chatTyping", () =>
        staff.emit("chatTyping", { driverUserId: DRIVER_USER }),
      );

      expect(reached).toEqual([{ userName: "Atendente" }]);

      // Another tenant's driver: the room named after the SENDER's company
      // has nobody in it.
      const leaked = count(otherDriver, "chatTyping", 1_000);

      staff.emit("chatTyping", { driverUserId: OTHER_DRIVER_USER });

      expect(await leaked).toEqual([]);

      // A padded id is dropped before it becomes a room name.
      const padded = count(driver, "chatRecording", 800);

      staff.emit("chatRecording", {
        driverUserId: "x".repeat(900),
        recording: true,
      });

      expect(await padded).toEqual([]);

      expect(fetches).not.toHaveBeenCalled();
    } finally {
      fetches.mockRestore();
    }
  });

  it(
    "still relays recording to the right driver",
    { timeout: 20_000 },
    async () => {
      // The bucket refills with time, whatever the machine's load.
      await new Promise((done) =>
        setTimeout(done, (HINT_BURST + 1) * HINT_REFILL_MS),
      );

      const reached = await arrivals(driver, "chatRecording", () =>
        staff.emit("chatRecording", {
          driverUserId: DRIVER_USER,
          recording: true,
        }),
      );

      expect(reached).toEqual([{ userName: "Atendente", recording: true }]);
    },
  );
});

describe("presence", () => {
  it("answers only about the users asked for", async () => {
    // The staff member is connected too, and not asked about.
    expect(await io.getOnlineUserIds([DRIVER_USER])).toEqual([DRIVER_USER]);

    expect(
      (await io.getOnlineUserIds([DRIVER_USER, randomUUID()])).sort(),
    ).toEqual([DRIVER_USER]);

    expect(await io.getOnlineUserIds([])).toEqual([]);
  });

  it("with the adapter unreachable, answers from this replica instead of 'nobody'", async () => {
    const adapter = ioServer.of("/").adapter;
    const original = adapter.fetchSockets.bind(adapter);

    // Cluster-wide questions fail the way they do with Redis away; this
    // replica's own view still answers.
    const failing = vi
      .spyOn(adapter, "fetchSockets")
      .mockImplementation((options: any) =>
        options?.flags?.local
          ? original(options)
          : Promise.reject(new Error("Redis indisponível")),
      );

    try {
      expect(await io.getOnlineUserIds([DRIVER_USER])).toEqual([DRIVER_USER]);
    } finally {
      failing.mockRestore();
    }
  });

  it("does not carry anyone's access token in a fetch answer", async () => {
    const sockets = await ioServer.in(`user:${DRIVER_USER}`).fetchSockets();

    expect(sockets.length).toBeGreaterThan(0);

    for (const socket of sockets) {
      expect(
        (socket.handshake.auth as { token?: unknown }).token,
      ).toBeUndefined();
    }
  });
});

describe("a driver leaving while Redis is away", () => {
  it("is still stamped 'visto por último'", { timeout: 20_000 }, async () => {
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: DRIVER_USER },
    });

    expect(before.last_seen_at).toBeNull();

    const adapter = ioServer.of("/").adapter;
    const original = adapter.fetchSockets.bind(adapter);

    const failing = vi
      .spyOn(adapter, "fetchSockets")
      .mockImplementation((options: any) =>
        options?.flags?.local
          ? original(options)
          : Promise.reject(new Error("Redis indisponível")),
      );

    try {
      driver.disconnect();

      let stamped: Date | null = null;
      const deadline = Date.now() + 10_000;

      while (!stamped && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 200));

        stamped = (
          await prisma.user.findUniqueOrThrow({ where: { id: DRIVER_USER } })
        ).last_seen_at;
      }

      // Before: the failed cluster-wide fetch swallowed the whole branch,
      // and the driver stayed "never seen".
      expect(stamped).not.toBeNull();
    } finally {
      failing.mockRestore();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import type { Server as SocketIOServer } from "socket.io";

import auth from "@/config/auth";

import { socketClientEntry } from "./support/socket-client";

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
const prisma = new PrismaClient();

const CARRIER = "018fd000-0000-7000-8000-0000000c4a01";
const OTHER_CARRIER = "018fd000-0000-7000-8000-0000000c4a02";

const STAFF = "018fd000-0000-7000-8000-0000000c4a11";
const DRIVER_USER = "018fd000-0000-7000-8000-0000000c4a12";
const OTHER_DRIVER_USER = "018fd000-0000-7000-8000-0000000c4a13";

const DRIVER = "018fd000-0000-7000-8000-0000000c4a21";
const OTHER_DRIVER = "018fd000-0000-7000-8000-0000000c4a22";

interface TestSocket {
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

/** Counts one event on a socket for a while. */
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

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));

  staff = await connectAs(await tokenFor(STAFF, CARRIER, null));
  driver = await connectAs(await tokenFor(DRIVER_USER, CARRIER, DRIVER));
  otherDriver = await connectAs(
    await tokenFor(OTHER_DRIVER_USER, OTHER_CARRIER, OTHER_DRIVER),
  );

  // The connection handler joins rooms after the handshake's queries.
  await new Promise((done) => setTimeout(done, 1500));
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
    const received = count(staff, "chatTyping", 1_500);

    for (let frame = 0; frame < 1_000; frame += 1) {
      driver.emit("chatTyping");
    }

    const hints = await received;

    expect(hints.length).toBeGreaterThan(0);
    expect(hints.length).toBeLessThanOrEqual(8);
  });
});

describe("a staff typing hint", () => {
  it("never costs a cluster-wide fetch", { timeout: 20_000 }, async () => {
    const adapter = ioServer.of("/").adapter;
    const fetches = vi.spyOn(adapter, "fetchSockets");

    try {
      // Let the budget the loop above spent come back.
      await new Promise((done) => setTimeout(done, 2_500));

      const reached = count(driver, "chatTyping", 1_000);

      staff.emit("chatTyping", { driverUserId: DRIVER_USER });

      expect(await reached).toEqual([{ userName: "Atendente" }]);

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

  it("still relays recording to the right driver", { timeout: 20_000 }, async () => {
    await new Promise((done) => setTimeout(done, 2_500));

    const reached = count(driver, "chatRecording", 1_000);

    staff.emit("chatRecording", { driverUserId: DRIVER_USER, recording: true });

    expect(await reached).toEqual([{ userName: "Atendente", recording: true }]);
  });
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

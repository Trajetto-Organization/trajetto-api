import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { sign } from "jsonwebtoken";

import { socketClientEntry } from "./support/socket-client";
import { freePort, startReplica, type Replica } from "./support/replica-process";

/**
 * Chat typing and presence across replicas (CRIT-21, plan §13).
 *
 * `socket-chat-hints` proves the rules on one node. In production the driver's
 * phone and the dispatcher's panel sit on whichever replicas the balancer
 * picked, so here they do too: two replica processes on one Redis, plus this
 * process as a third node for the thread list's presence question.
 *
 *  - "digitando"/"gravando" cross in both directions;
 *  - a driver coming online on replica 1 is announced to the SAC on replica 2,
 *    and a third node sees him online;
 *  - a driver still connected on another replica is NOT announced offline
 *    when one of his sockets leaves — "visto por último" waits for the last;
 *  - with Redis unreachable, a replica still relays hints and presence among
 *    its own sockets instead of going silent.
 */

// The in-process node must share the replicas' channel prefix, and the env
// module reads it once, at import — so it is set before any import runs.
const ADAPTER_KEY = vi.hoisted(() => {
  const key = `socket.io-e2e-chat-${Math.random().toString(36).slice(2)}`;

  process.env.SOCKET_ADAPTER_KEY = key;

  return key;
});

const prisma = new PrismaClient();

const CARRIER = "018fe200-0000-7000-8000-00000000000a";

const STAFF = "018fe200-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018fe200-0000-7000-8000-0000000000a2";
const DRIVER = "018fe200-0000-7000-8000-0000000000d1";

const NEVER_MS = String(10 * 60 * 1000);

interface TestSocket {
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler: (...args: any[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  disconnect: () => void;
}

let connect: (url: string, options: unknown) => TestSocket;

const replicas: Replica[] = [];
let one: Replica;
let two: Replica;
let isolated: Replica;

let thirdNode: typeof import("@/websocket");
let thirdServer: Server;

let profileId = "";
const sockets: TestSocket[] = [];

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function tokenFor(userId: string, driverId: string | null): Promise<string> {
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

  const { default: auth } = await import("@/config/auth");

  return sign(
    {
      tokenType: "access",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

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
 * The first matching event, or null. Generous: negative assertions are made
 * of this timeout, and a slow crossing must not read as none.
 */
function next(
  socket: TestSocket,
  event: string,
  matches: (payload: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<Record<string, unknown> | null> {
  return new Promise((done) => {
    const handler = (payload: Record<string, unknown>) => {
      if (!matches(payload)) return;

      clearTimeout(timer);
      socket.off(event, handler);
      done(payload);
    };

    const timer = setTimeout(() => {
      socket.off(event, handler);
      done(null);
    }, timeoutMs);

    socket.on(event, handler);
  });
}

const aboutDriver = (payload: Record<string, unknown>) =>
  payload.userId === DRIVER_USER;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Réplicas do Chat",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(63000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `replicas-chat-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista das Réplicas",
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: `${Date.now()}`.slice(-11),
      rg: randomUUID().slice(0, 9),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

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
        name: "Atendente da Réplica 2",
        email: `atendente-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: profile.id,
      },
      {
        id: DRIVER_USER,
        name: "Motorista das Réplicas",
        email: `motorista-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId: DRIVER,
      },
    ],
  });

  const redis = process.env.REDIS_URL ?? "redis://localhost:6379";

  one = await startReplica({
    REDIS_URL: redis,
    SOCKET_ADAPTER_KEY: ADAPTER_KEY,
    SOCKET_REVALIDATE_MS: NEVER_MS,
  });
  two = await startReplica({
    REDIS_URL: redis,
    SOCKET_ADAPTER_KEY: ADAPTER_KEY,
    SOCKET_REVALIDATE_MS: NEVER_MS,
  });

  // Nothing listens on this port: Redis is down for this replica only.
  isolated = await startReplica({
    REDIS_URL: `redis://127.0.0.1:${await freePort()}`,
    SOCKET_REVALIDATE_MS: NEVER_MS,
  });

  replicas.push(one, two, isolated);

  // This process joins the cluster as a third node, the one that answers
  // the thread list's presence dots in the test below.
  thirdServer = createServer();
  await new Promise<void>((done) => thirdServer.listen(0, "127.0.0.1", done));

  thirdNode = await import("@/websocket");
  await thirdNode.initializeSocketIO(thirdServer);

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));
}, 600_000);

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();

  await Promise.all(replicas.map((replica) => replica.stop()));

  await thirdNode?.shutdownSocketIO();
  await new Promise<void>((done) => thirdServer?.close(() => done()));

  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [STAFF, DRIVER_USER] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [STAFF, DRIVER_USER] } } });
  await prisma.driver.deleteMany({ where: { id: DRIVER } });
  await prisma.permission.deleteMany({ where: { profileAccessId: profileId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileId } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
}, 60_000);

describe("across replicas", () => {
  let staff: TestSocket;
  let driverOnOne: TestSocket;

  it("announces a driver coming online on replica 1 to the SAC on replica 2", { timeout: 60_000 }, async () => {
    staff = await connectTo(two.port, await tokenFor(STAFF, null));

    // Rooms are joined after the handshake's queries.
    await sleep(1_500);

    const online = next(staff, "chatPresence", aboutDriver);

    driverOnOne = await connectTo(one.port, await tokenFor(DRIVER_USER, DRIVER));

    expect(await online).toMatchObject({
      driverId: DRIVER,
      userId: DRIVER_USER,
      online: true,
    });
  });

  it("is seen online by a third node, for the thread list's dot", { timeout: 30_000 }, async () => {
    expect(await thirdNode.getOnlineUserIds([DRIVER_USER, STAFF])).toEqual(
      expect.arrayContaining([DRIVER_USER, STAFF]),
    );
    expect(await thirdNode.getOnlineUserIds([randomUUID()])).toEqual([]);
  });

  it("relays typing and recording in both directions", { timeout: 30_000 }, async () => {
    const driverTyping = next(staff, "chatTyping");
    driverOnOne.emit("chatTyping");

    expect(await driverTyping).toEqual({
      driverId: DRIVER,
      userName: "Motorista das Réplicas",
    });

    const staffTyping = next(driverOnOne, "chatTyping");
    staff.emit("chatTyping", { driverUserId: DRIVER_USER });

    expect(await staffTyping).toEqual({ userName: "Atendente da Réplica 2" });

    const staffRecording = next(driverOnOne, "chatRecording");
    staff.emit("chatRecording", { driverUserId: DRIVER_USER, recording: true });

    expect(await staffRecording).toEqual({
      userName: "Atendente da Réplica 2",
      recording: true,
    });
  });

  it("keeps him online while another replica still holds one of his sockets", { timeout: 60_000 }, async () => {
    const driverOnTwo = await connectTo(two.port, await tokenFor(DRIVER_USER, DRIVER));

    await sleep(1_500);

    const earlyOffline = next(
      staff,
      "chatPresence",
      (payload) => aboutDriver(payload) && payload.online === false,
      3_000,
    );

    driverOnOne.disconnect();

    // The cluster-wide count still finds the socket on replica 2.
    expect(await earlyOffline).toBeNull();

    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: DRIVER_USER } }))
        .last_seen_at,
    ).toBeNull();

    const offline = next(
      staff,
      "chatPresence",
      (payload) => aboutDriver(payload) && payload.online === false,
    );

    driverOnTwo.disconnect();

    const announced = await offline;

    expect(announced).toMatchObject({ driverId: DRIVER, online: false });
    expect(typeof announced?.last_seen_at).toBe("string");

    const stamped = await prisma.user.findUniqueOrThrow({
      where: { id: DRIVER_USER },
    });

    expect(stamped.last_seen_at).not.toBeNull();
  });
});

describe("a replica whose Redis is unreachable", () => {
  it("still relays hints and presence among its own sockets", { timeout: 60_000 }, async () => {
    const staff = await connectTo(isolated.port, await tokenFor(STAFF, null));

    await sleep(1_500);

    const online = next(staff, "chatPresence", aboutDriver);

    const driver = await connectTo(
      isolated.port,
      await tokenFor(DRIVER_USER, DRIVER),
    );

    // The cluster-wide question fails; this replica's own view answers.
    expect(await online).toMatchObject({ userId: DRIVER_USER, online: true });

    const typing = next(staff, "chatTyping");
    driver.emit("chatTyping");

    expect(await typing).toMatchObject({ driverId: DRIVER });

    const offline = next(
      staff,
      "chatPresence",
      (payload) => aboutDriver(payload) && payload.online === false,
    );

    driver.disconnect();

    expect(await offline).toMatchObject({ userId: DRIVER_USER, online: false });
  });
});

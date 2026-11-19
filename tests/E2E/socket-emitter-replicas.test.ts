import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import Redis from "ioredis";
import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { operationsRoom } from "@/shared/socket/operations-access";
import { closePubSub, isReady, subscribe } from "@/shared/redis/pubsub-redis";
import {
  parseLaneMessage,
  startTemplateLaneListener,
} from "@/shared/providers/whatsapp-provider/template-lane-bus";

import { socketClientEntry } from "./support/socket-client";
import { startReplica, type Replica } from "./support/replica-process";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The api without sockets, the realtime with them (plano-escala U-07, F4.9).
 *
 * After the cut, `trajetto-realtime` holds every socket and the api runs
 * with SOCKETS_ENABLED=false. The api still emits (a route event, a
 * revocation, a permission change), and before this it did so through the
 * Socket.IO adapter, whose PSUBSCRIBE also made Redis send it every frame
 * the cluster published. Now it publishes through the Redis emitter and
 * subscribes to nothing of the adapter. Two processes, as on the staging:
 *
 *  - the api's adapter question answers "emitter", and Redis counts only
 *    the realtime's subscription on the adapter's request channel;
 *  - an emit to a room, a revocation by room (`disconnectSockets`) and a
 *    `serverSideEmit` (the dispatch rooms re-evaluated) from the api all
 *    reach the socket on the realtime;
 *  - the WhatsApp template lane, which a process without the adapter can
 *    no longer hear as a `serverSideEmit`, arrives on its own channel to
 *    whoever drains `external`, within the 5 s of the plan.
 */
const prisma = createPrismaClient();

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** A channel prefix of its own: Pub/Sub ignores the database number. */
const ADAPTER_KEY = `socket.io-e2e-emitter-${randomUUID()}`;

const NEVER_MS = String(10 * 60 * 1000);

const CARRIER = "018fdc10-0000-7000-8000-0000000004a0";
const WATCHER = "018fdc10-0000-7000-8000-0000000004a1";
const REVOKED = "018fdc10-0000-7000-8000-0000000004a2";

interface TestSocket {
  id: string;
  connected: boolean;
  on: Function;
  off: Function;
  once: Function;
  disconnect: () => void;
}

let connect: (url: string, options: unknown) => TestSocket;

let realtime: Replica;
let api: Replica;
let profileId = "";
const sockets: TestSocket[] = [];

function open(port: number, token: string): Promise<TestSocket> {
  return new Promise((done, fail) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(
      () => fail(new Error(`o socket não respondeu na porta ${port}`)),
      20_000,
    );

    socket.on("connect", () => {
      clearTimeout(timer);
      sockets.push(socket);
      done(socket);
    });

    socket.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      socket.disconnect();
      fail(error);
    });
  });
}

function waitFor(
  socket: TestSocket,
  event: string,
  timeoutMs = 10_000,
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

async function tokenFor(userId: string): Promise<string> {
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
      businessId: CARRIER,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Emissor",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(63000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `emissor-${randomUUID()}@example.com`,
    },
  });

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Despacho",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Despacho",
            canRead: true,
            canWrite: false,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  profileId = profile.id;

  await prisma.user.createMany({
    data: [WATCHER, REVOKED].map((id) => ({
      id,
      name: `Despachante ${id.slice(-2)}`,
      email: `emissor-${id.slice(-2)}-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "BUSINESS_USER" as const,
      businessId: CARRIER,
      profileAccessId: profileId,
    })),
  });

  const shared = {
    REDIS_URL,
    SOCKET_ADAPTER_KEY: ADAPTER_KEY,
    SOCKET_REVALIDATE_MS: NEVER_MS,
  };

  realtime = await startReplica({ ...shared, PROCESS_ROLE: "realtime" });
  api = await startReplica({
    ...shared,
    PROCESS_ROLE: "api",
    SOCKETS_ENABLED: "false",
  });

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));
}, 300_000);

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();

  await Promise.all([realtime, api].map((replica) => replica?.stop()));
  await closePubSub();

  const users = [WATCHER, REVOKED];

  await prisma.userPresence.deleteMany({ where: { user_id: { in: users } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.permission.deleteMany({ where: { profileAccessId: profileId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileId } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

describe("an api without sockets", () => {
  it("emits through the emitter and subscribes to none of the adapter's channels", async () => {
    expect((await api.adapter()).emitter).toBe(true);
    expect((await realtime.adapter()).emitter).toBe(false);

    const redis = new Redis(REDIS_URL);

    try {
      // Every adapter subscribes to the namespace's request channel; the
      // emitter does not. Only the realtime's is there.
      const [, subscribers] = (await redis.pubsub(
        "NUMSUB",
        `${ADAPTER_KEY}-request#/#`,
      )) as [string, number];

      expect(Number(subscribers)).toBe(1);
    } finally {
      redis.disconnect();
    }
  });

  it("reaches the dispatcher on the realtime with an event to a room", async () => {
    const watcher = await open(realtime.port, await tokenFor(WATCHER));

    await realtime.waitForRoom(watcher.id, operationsRoom(CARRIER), true);

    const heard = waitFor(watcher, "routeEvent");

    await api.run({
      kind: "routeEvent",
      businessId: CARRIER,
      payload: {
        type: "route.released",
        routeId: "018fdc10-0000-7000-8000-0000000004b1",
        routeCode: 78,
      },
    });

    expect((await heard)?.routeCode).toBe(78);
  });

  it("ends a session on the realtime by room, through the emitter", async () => {
    const revoked = await open(realtime.port, await tokenFor(REVOKED));

    await realtime.waitForRoom(revoked.id, `user:${REVOKED}`, true);

    const announced = waitFor(revoked, "securityAction");

    await api.run({
      kind: "securityToUser",
      businessId: CARRIER,
      payload: { userId: REVOKED, reason: "access_revoked" },
    });

    expect(await announced).toMatchObject({ reason: "access_revoked" });

    // The REMOTE_DISCONNECT the realtime's adapter acts on.
    await vi.waitFor(() => expect(revoked.connected).toBe(false), {
      timeout: 10_000,
      interval: 50,
    });
  });

  it("makes the realtime re-evaluate its dispatch rooms with a serverSideEmit", async () => {
    const watcher = sockets.find((socket) => socket.connected);

    expect(watcher, "o despachante do caso anterior").toBeDefined();

    await prisma.permission.updateMany({
      where: { profileAccessId: profileId, permissionKey: "delivery_manage" },
      data: { canRead: false },
    });

    try {
      await api.run({ kind: "refreshRooms", businessId: CARRIER, payload: {} });

      await realtime.waitForRoom(watcher!.id, operationsRoom(CARRIER), false);
    } finally {
      await prisma.permission.updateMany({
        where: { profileAccessId: profileId, permissionKey: "delivery_manage" },
        data: { canRead: true },
      });
    }
  });
});

describe("the WhatsApp template lane", () => {
  it("reaches a process that drains external without the adapter, within 5 s", async () => {
    const applied: unknown[] = [];

    // This process plays the worker-external: SOCKETS_ENABLED=false and
    // the external queue, listening on the replicas' channel.
    const stop = startTemplateLaneListener({
      publish: async () => 0,
      listen: subscribe,
      apply: (change) => applied.push(change),
      channel: () => `${ADAPTER_KEY}:lane`,
      replica: () => "e2e-worker-external",
      listens: () => true,
    });

    const raw: string[] = [];
    const stopRaw = subscribe(`${ADAPTER_KEY}:lane`, (message) =>
      raw.push(message),
    );

    try {
      await vi.waitFor(() => expect(isReady()).toBe(true), {
        timeout: 15_000,
        interval: 50,
      });

      const change = { template: "entrega_saiu", action: "pause", seconds: 60 };

      // Announced until the subscription has its first message: the
      // SUBSCRIBE is acknowledged after the connection's ready.
      const startedAt = Date.now();

      await vi.waitFor(
        async () => {
          if (applied.length === 0) {
            await api.run({ kind: "lane", businessId: "", payload: change });
          }

          expect(applied).toContainEqual(change);
        },
        { timeout: 15_000, interval: 250 },
      );

      expect(Date.now() - startedAt).toBeLessThan(5_000);

      const message = parseLaneMessage(raw[0]);

      expect(message).toMatchObject({ v: 1, change });
      expect(message?.replica).not.toBe("e2e-worker-external");
    } finally {
      stop();
      stopRaw();
    }
  });
});

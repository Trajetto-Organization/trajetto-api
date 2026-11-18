import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { operationsRoom } from "@/shared/socket/operations-access";
import {
  closePubSub,
  generation,
  isReady,
  subscribe,
} from "@/shared/redis/pubsub-redis";
import { startWakeListener } from "@/shared/wake/wake-listener";

import { socketClientEntry } from "./support/socket-client";
import { startReplica, type Replica } from "./support/replica-process";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Processes of different roles, side by side (plano-escala F3-02).
 *
 * A worker takes no sockets (SOCKETS_ENABLED=false in its preset): its
 * upgrades are refused at the engine. But it still EMITS — a notification
 * expanded, an AI reading finished — and those events must reach the
 * dispatcher connected to the API. They do because the Socket.IO server and
 * its Redis adapter stay up in the worker; the only thing switched off is
 * the admission. Two processes, as in production: a worker and an `all`
 * replica, one Redis, one database, one adapter key.
 *
 * And the wake between processes (F3-04): an `api` replica that enqueues
 * work it does not claim publishes the hint on Redis, and the process that
 * claims the queue (here, this test's own listener) wakes; an `all`
 * replica, which claims everything and woke itself, publishes nothing.
 */
const prisma = createPrismaClient();

interface RawSocket {
  on(event: string, listener: (...args: any[]) => void): void;
  close(): void;
}

const WebSocket = createRequire(__filename)("ws") as new (
  url: string,
) => RawSocket;

const CARRIER = "018fdc00-0000-7000-8000-0000000003a0";
const WATCHER = "018fdc00-0000-7000-8000-0000000003a1";

let profileId = "";

const REPLICA_REDIS = process.env.REDIS_URL ?? "redis://localhost:6379";

/** A channel prefix of its own: Pub/Sub ignores the database number. */
const REPLICA_ADAPTER_KEY = `socket.io-e2e-roles-${randomUUID()}`;

interface TestSocket {
  id: string;
  on: Function;
  off: Function;
  disconnect: () => void;
}

let connect: (url: string, options: unknown) => TestSocket;

let worker: Replica;
let api: Replica;
let apiRole: Replica;
let watcher: TestSocket | undefined;

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
  timeoutMs = 5_000,
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

async function tokenFor(userId: string, businessId: string): Promise<string> {
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
      corporate_reason: "Transportadora dos Papéis",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(62000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `roles-${randomUUID()}@example.com`,
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

  await prisma.user.create({
    data: {
      id: WATCHER,
      name: "Despachante na API",
      email: `roles-watcher-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: profileId,
    },
  });

  const shared = {
    REDIS_URL: REPLICA_REDIS,
    SOCKET_ADAPTER_KEY: REPLICA_ADAPTER_KEY,
  };

  // The worker's role, by its preset alone: SOCKETS_ENABLED is not given.
  worker = await startReplica({ ...shared, PROCESS_ROLE: "worker" });
  api = await startReplica({ ...shared, PROCESS_ROLE: "all" });
  apiRole = await startReplica({ ...shared, PROCESS_ROLE: "api" });

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));
}, 300_000);

afterAll(async () => {
  watcher?.disconnect();

  await Promise.all([worker, api, apiRole].map((replica) => replica?.stop()));
  await closePubSub();

  await prisma.refreshToken.deleteMany({ where: { userId: WATCHER } });
  await prisma.user.deleteMany({ where: { id: WATCHER } });
  await prisma.permission.deleteMany({ where: { profileAccessId: profileId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileId } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

describe("a worker (SOCKETS_ENABLED=false by its preset)", () => {
  it("refuses a socket at the upgrade, with SOCKET_UNAVAILABLE", async () => {
    const token = await tokenFor(WATCHER, CARRIER);

    await expect(open(worker.port, token)).rejects.toThrow();

    // Why, from the upgrade's own answer, which a browser never shows.
    const refusal = await new Promise<{ status: number; body: string }>(
      (done, fail) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${worker.port}/socket.io/?EIO=4&transport=websocket`,
        );

        socket.on("open", () => {
          socket.close();
          fail(new Error("o worker aceitou o websocket"));
        });

        socket.on(
          "unexpected-response",
          (
            _request: unknown,
            response: NodeJS.ReadableStream & {
              statusCode: number;
            },
          ) => {
            let body = "";

            response.on("data", (chunk: Buffer) => (body += String(chunk)));
            response.on("end", () =>
              done({ status: response.statusCode, body }),
            );
          },
        );

        socket.on("error", () => undefined);
      },
    );

    expect(refusal.status).toBe(400);
    expect(refusal.body).toContain("SOCKET_UNAVAILABLE");
  });

  it("still emits: its event reaches the dispatcher connected to the API", async () => {
    watcher = await open(api.port, await tokenFor(WATCHER, CARRIER));

    await api.waitForRoom(watcher.id, operationsRoom(CARRIER), true);

    const heard = waitFor(watcher, "routeEvent");

    await worker.run({
      kind: "routeEvent",
      businessId: CARRIER,
      payload: {
        type: "route.released",
        routeId: "018fdc00-0000-7000-8000-0000000003b1",
        routeCode: 77,
      },
    });

    const event = await heard;

    expect(
      event,
      "o evento do worker não chegou ao socket conectado na API",
    ).not.toBeNull();
    expect(event!.routeCode).toBe(77);
  });
});

describe("the wake between processes", () => {
  it("reaches the process that claims the queue from an api that does not, and never from an all", async () => {
    let woken = 0;

    // This process plays the worker: it claims the outbox, listens on the
    // replicas' channel and names itself apart from them.
    const stop = startWakeListener(
      { outbox: () => (woken += 1) },
      {
        consumes: (queue) => queue === "outbox",
        listen: subscribe,
        generation,
        channel: (queue) => `${REPLICA_ADAPTER_KEY}:wake:${queue}`,
        replica: () => "e2e-worker",
      },
    );

    try {
      await vi.waitFor(() => expect(isReady()).toBe(true), {
        timeout: 15_000,
        interval: 50,
      });

      // The api's enqueue, announced until the subscription has its first
      // hint: the SUBSCRIBE is acknowledged after the connection's ready.
      await vi.waitFor(
        async () => {
          await apiRole.run({
            kind: "wake",
            businessId: "",
            payload: { queue: "outbox" },
          });

          await new Promise((done) => setTimeout(done, 200));

          expect(woken).toBeGreaterThan(0);
        },
        { timeout: 15_000, interval: 50 },
      );

      // The all replica claims the outbox and woke itself: zero PUBLISH.
      // A negative, so a window: ten debounces of the bus.
      woken = 0;

      await api.run({
        kind: "wake",
        businessId: "",
        payload: { queue: "outbox" },
      });

      await new Promise((done) => setTimeout(done, 1_000));

      expect(woken).toBe(0);
    } finally {
      stop();
    }
  });
});

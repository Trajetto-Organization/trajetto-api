import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";

import { FakeProvider } from "./support/fake-provider";
import {
  freePort,
  startReplica,
  type Replica,
} from "./support/replica-process";
import {
  startPipelineReplica,
  type PipelineReplica,
} from "./support/pipeline-replica-process";
import {
  dockerFailureInjectionEnabled,
  startRedis,
  stopRedis,
} from "./support/resilience-containers";
import {
  publishAccountPayables,
  seedResilienceTenant,
  waitUntilSettled,
  type ResilienceSeed,
} from "./support/resilience-seed";
import { socketClientEntry } from "./support/socket-client";

/**
 * Case D of contract §11: Redis dies while the API is running, and comes
 * back. ADR 0002 says Redis is disposable — rate-limit counters and the
 * Socket.IO bus, nothing of business — so its loss must degrade, never stop:
 *
 *  - HTTP keeps answering, promptly (the limiter fails open within its
 *    250 ms command timeout instead of hanging every request);
 *  - the notification pipeline does not notice (Postgres is the only queue);
 *  - no replica process dies (the adapter's failed publishes are absorbed);
 *  - when Redis is back, the limiter counts again and an event emitted on one
 *    replica reaches the other again — without restarting anything — and
 *    arrives once, not once per reconnection.
 *
 * The cross-replica frame emitted DURING the outage is lost: the bus is
 * at-most-once by design (the bell and the screens' refetch are the truth).
 *
 * Runs only under tests/E2E/support/resilience-run.sh, which owns the Redis
 * it stops (see resilience-containers.ts).
 */
const enabled = dockerFailureInjectionEnabled();

const prisma = new PrismaClient();
const fake = new FakeProvider();

const BUSINESS = "018fe800-0000-7000-8000-0000000000a1";
const WATCHER = "018fe800-0000-7000-8000-0000000000c1";

let seed: ResilienceSeed;
let pipeline: PipelineReplica | null = null;
let httpPort = 0;
const socketReplicas: Replica[] = [];

interface TestSocket {
  on: Function;
  off: Function;
  disconnect: () => void;
}

let connect: (url: string, options: unknown) => TestSocket;
let watcher: TestSocket | null = null;

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
      done(socket);
    });

    socket.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
}

/** Every routeEvent with this code the socket hears within `ms`. */
function collect(
  socket: TestSocket,
  code: number,
  ms: number,
): Promise<number> {
  return new Promise((done) => {
    let heard = 0;
    const handler = (payload: { routeCode?: number }) => {
      if (payload?.routeCode === code) heard += 1;
    };

    socket.on("routeEvent", handler);

    setTimeout(() => {
      socket.off("routeEvent", handler);
      done(heard);
    }, ms);
  });
}

async function get(path: string, token: string) {
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${httpPort}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });

  await response.arrayBuffer();

  return {
    status: response.status,
    ms: Date.now() - startedAt,
    remaining: response.headers.get("x-ratelimit-remaining"),
  };
}

beforeAll(async () => {
  if (!enabled) return;

  await fake.listen();
  seed = await seedResilienceTenant(prisma, BUSINESS);

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Despacho",
      businessId: BUSINESS,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Despacho",
            canRead: true,
            canWrite: false,
            businessId: BUSINESS,
          },
        ],
      },
    },
  });

  await prisma.user.create({
    data: {
      id: WATCHER,
      name: "Despachante",
      email: `despacho-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      profileAccessId: profile.id,
    },
  });

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));
}, 120_000);

afterAll(async () => {
  if (!enabled) return;

  watcher?.disconnect();
  await Promise.allSettled(socketReplicas.map((replica) => replica.stop()));
  await pipeline?.kill();

  // Never leave the package's Redis down for the next file.
  await startRedis().catch(() => undefined);

  await fake.close();
  await prisma.$disconnect();
}, 120_000);

async function watcherToken(): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: WATCHER,
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
      businessId: BUSINESS,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: WATCHER, expiresIn: "1h" },
  );
}

describe.skipIf(!enabled)(
  "Redis lost and back while the API runs (case D)",
  () => {
    it(
      "HTTP and the pipeline carry on without it, and the limiter counts again when it returns",
      { timeout: 600_000 },
      async () => {
        httpPort = await freePort();
        pipeline = await startPipelineReplica({
          fakeProviderUrl: fake.url,
          workers: ["notifications"],
          httpPort,
        });

        const healthy = await get("/notification/preferences", seed.adminToken);

        expect(healthy.status).toBe(200);
        expect(
          healthy.remaining,
          "o limitador conta com o Redis de pé",
        ).not.toBeNull();

        await stopRedis();

        try {
          // Fail open, and fast: the limiter's command timeout, not a hang.
          const degraded = await get(
            "/notification/preferences",
            seed.adminToken,
          );

          expect(degraded.status).toBe(200);
          expect(degraded.ms).toBeLessThan(3_000);

          // Postgres is the queue: the drain does not care.
          await publishAccountPayables(prisma, seed, 5);
          await waitUntilSettled(prisma, "a drenagem com o Redis fora", 60_000);

          expect(fake.callsOf("email")).toHaveLength(5);
          expect(fake.repeated("email")).toEqual([]);
          expect(
            pipeline.process.exitCode,
            pipeline.output().slice(-2_000),
          ).toBeNull();
        } finally {
          await startRedis();
        }

        // The limiter's client reconnects on its own: counting again, no restart.
        const deadline = Date.now() + 60_000;
        let after = await get("/notification/preferences", seed.adminToken);

        while (after.remaining === null && Date.now() < deadline) {
          await new Promise((done) => setTimeout(done, 1_000));
          after = await get("/notification/preferences", seed.adminToken);
        }

        expect(after.status).toBe(200);
        expect(
          after.remaining,
          "o limitador não voltou a contar depois do Redis voltar",
        ).not.toBeNull();
        expect(pipeline.process.exitCode).toBeNull();
      },
    );

    it(
      "the bus drops what is emitted during the outage, crashes nobody, and carries events again — once — after it",
      { timeout: 600_000 },
      async () => {
        const adapterKey = `socket.io-resil-${randomUUID()}`;
        const env = {
          REDIS_URL: process.env.REDIS_URL as string,
          SOCKET_ADAPTER_KEY: adapterKey,
        };

        const emitter = await startReplica(env);
        const listener = await startReplica(env);

        socketReplicas.push(emitter, listener);

        watcher = await connectTo(listener.port, await watcherToken());

        // The connection handler reads the user and the profile before joining.
        await new Promise((done) => setTimeout(done, 2_500));

        const before = collect(watcher, 1, 4_000);

        await emitter.run({
          kind: "routeEvent",
          businessId: BUSINESS,
          payload: { type: "route.released", routeCode: 1 },
        });
        expect(await before, "o evento atravessa com o Redis de pé").toBe(1);

        await stopRedis();

        try {
          const during = collect(watcher, 2, 4_000);

          // The emit itself must not throw nor kill the replica (REDIS-01).
          await emitter.run({
            kind: "routeEvent",
            businessId: BUSINESS,
            payload: { type: "route.released", routeCode: 2 },
          });

          expect(await during).toBe(0);
          expect(emitter.process.exitCode).toBeNull();
          expect(listener.process.exitCode).toBeNull();
        } finally {
          await startRedis();
        }

        // Both adapters reconnect and resubscribe by themselves; probe until a
        // frame crosses again, then check the one that crossed came once.
        const deadline = Date.now() + 90_000;
        let code = 100;
        let heard = 0;

        while (heard === 0 && Date.now() < deadline) {
          code += 1;

          const listening = collect(watcher, code, 3_000);

          await emitter.run({
            kind: "routeEvent",
            businessId: BUSINESS,
            payload: { type: "route.released", routeCode: code },
          });
          heard = await listening;
        }

        expect(heard, "o barramento não voltou depois do Redis voltar").toBe(1);

        // Steady again: one more event, one arrival — a resubscription that
        // doubled the subscriber would deliver it twice.
        const steady = collect(watcher, 999, 4_000);

        await emitter.run({
          kind: "routeEvent",
          businessId: BUSINESS,
          payload: { type: "route.released", routeCode: 999 },
        });
        expect(await steady).toBe(1);
      },
    );
  },
);

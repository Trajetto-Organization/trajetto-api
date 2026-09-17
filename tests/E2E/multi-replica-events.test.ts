import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * An event crossing from one replica to another, and to a third.
 *
 * This is the assumption the whole realtime layer rests on, and the one thing
 * none of the other socket tests could reach: they boot Socket.IO inside the
 * test's own process, so every emitter and every listener share one node. That
 * proves the rooms. It says nothing at all about the adapter — and in
 * production nobody is on one node.
 *
 * What breaks without it is not subtle. A dispatcher watching the control
 * tower is connected to whichever replica the load balancer picked. The
 * driver's app posts a position to a different one. If the event does not
 * cross, the map simply stops moving — no error, no log line, no failed
 * request. It looks exactly like a truck that is not driving, which is the
 * worst failure mode this product has: indistinguishable from the thing it is
 * supposed to be reporting.
 *
 * `docs/PENDENCIAS-DO-USUARIO.md` #14 said this needed two machines. It does
 * not. A replica is a process, not a host: three of them on one laptop, one
 * Redis, one database — same adapter, same channels, same code path. The only
 * thing a second machine would add is the network between them, and the
 * network is not what the adapter is for.
 *
 * Three nodes, because two cannot tell "the adapter forwards" apart from "the
 * adapter happens to reach the one peer it has". The shape asserted is the one
 * the plan asks for:
 *
 *     node 1 -> event -> node 2
 *     node 2 -> event -> node 3
 */
const prisma = new PrismaClient();

const CARRIER = "018fdc00-0000-7000-8000-00000000000a";
const OTHER_CARRIER = "018fdc00-0000-7000-8000-00000000000b";

const WATCHER_ON_TWO = "018fdc00-0000-7000-8000-0000000000a1";
const WATCHER_ON_THREE = "018fdc00-0000-7000-8000-0000000000a2";
const STRANGER = "018fdc00-0000-7000-8000-0000000000b1";

const ROUTE = "018fdc00-0000-7000-8000-0000000000r1";
const DRIVER = "018fdc00-0000-7000-8000-0000000000d1";

let dispatcherProfile = "";
let strangerProfile = "";

/**
 * A Redis database of its own for the adapter's channels.
 *
 * Those channels are global to the Redis instance, and this machine also runs
 * the dev API and other suites against the same one. Without the separation a
 * passing run could be a message that arrived from something else entirely,
 * which would make the test say yes for a reason that is not the reason.
 */
const REPLICA_REDIS = `${process.env.REDIS_URL ?? "redis://localhost:6379"}/7`;

interface Replica {
  process: ChildProcessWithoutNullStreams;
  port: number;

  /** Resolves once the replica reports the emit went out. */
  emit: (
    kind: "routeEvent" | "driverPosition",
    payload: unknown,
  ) => Promise<void>;
}

const replicas: Replica[] = [];

/** A port the OS just said is free, which beats guessing one. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();

    probe.once("error", fail);

    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

async function startReplica(businessId: string): Promise<Replica> {
  const port = await freePort();

  /*
    node + tsx's own entry, rather than `npx tsx`. On Windows `npx` is a .cmd,
    and since Node 20 spawning one without a shell fails outright with EINVAL;
    going through a shell to work around that would put quoting between this
    test and the thing it is testing.
  */
  const child = spawn(
    process.execPath,
    [
      resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      "tests/E2E/support/socket-replica.ts",
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,

        /*
          The per-file database this suite created. A replica pointed at the
          default one would authenticate against users that do not exist there,
          and every socket would be refused for the wrong reason.
        */
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: REPLICA_REDIS,
        PORT: String(port),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams;

  const lines: string[] = [];

  let failure = "";

  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) lines.push(line.trim());
    }
  });

  // Kept so a replica that dies during boot says why, instead of timing out
  // with no explanation at all.
  child.stderr.on("data", (chunk) => {
    failure += String(chunk);
  });

  const waitForLine = (matches: (line: string) => boolean, timeoutMs: number) =>
    new Promise<void>((done, fail) => {
      const deadline = Date.now() + timeoutMs;

      const poll = setInterval(() => {
        const index = lines.findIndex(matches);

        if (index >= 0) {
          lines.splice(index, 1);
          clearInterval(poll);
          done();
          return;
        }

        if (Date.now() > deadline) {
          clearInterval(poll);
          fail(
            new Error(
              `a réplica na porta ${port} não respondeu a tempo. ${failure.slice(-1200)}`,
            ),
          );
        }
      }, 50);
    });

  await waitForLine((line) => line.startsWith("READY"), 180_000);

  return {
    process: child,
    port,
    emit: async (kind, payload) => {
      child.stdin.write(`${JSON.stringify({ kind, businessId, payload })}\n`);

      await waitForLine((line) => line === `SENT ${kind}`, 15_000);
    },
  };
}

interface TestSocket {
  on: Function;
  off: Function;
  disconnect: () => void;
}

let connect: (url: string, options: unknown) => TestSocket;

async function loadClient(): Promise<void> {
  const entry = pathToFileURL(
    resolve(
      process.cwd(),
      "..",
      "trajetto-fleet-manager-ui",
      "node_modules",
      "socket.io-client",
      "build",
      "esm",
      "index.js",
    ),
  ).href;

  ({ io: connect } = await import(/* @vite-ignore */ entry));
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
      done(socket);
    });

    socket.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
}

/**
 * Listens for one event, or gives up.
 *
 * Generous, because a negative assertion is made out of this timeout: an event
 * that is merely SLOW to cross would otherwise read as one that never crossed,
 * and the test would pass for the wrong reason.
 */
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
      cnpj: String(61000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `replica-${randomUUID()}@exemplo.com.br`,
    },
  });
}

async function seedProfile(businessId: string, name: string): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name,
      businessId,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: name,
            canRead: true,
            canWrite: false,
            businessId,
          },
        ],
      },
    },
  });

  return profile.id;
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

let onTwo: TestSocket;
let onThree: TestSocket;
let stranger: TestSocket;

beforeAll(async () => {
  await seedBusiness(CARRIER, "Transportadora das Réplicas");
  await seedBusiness(OTHER_CARRIER, "Transportadora Vizinha");

  dispatcherProfile = await seedProfile(CARRIER, "Despacho");
  strangerProfile = await seedProfile(OTHER_CARRIER, "Despacho Vizinho");

  await prisma.user.createMany({
    data: [
      {
        id: WATCHER_ON_TWO,
        name: "Despachante na réplica 2",
        email: `r2-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: dispatcherProfile,
      },
      {
        id: WATCHER_ON_THREE,
        name: "Despachante na réplica 3",
        email: `r3-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: dispatcherProfile,
      },
      {
        id: STRANGER,
        name: "Despachante de outra transportadora",
        email: `vizinho-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: OTHER_CARRIER,
        profileAccessId: strangerProfile,
      },
    ],
  });

  // Three replicas of the same API, on one machine, sharing one Redis and one
  // database — which is what a replica is.
  for (let node = 0; node < 3; node += 1) {
    replicas.push(await startReplica(CARRIER));
  }

  await loadClient();

  onTwo = await connectTo(
    replicas[1].port,
    await tokenFor(WATCHER_ON_TWO, CARRIER),
  );

  onThree = await connectTo(
    replicas[2].port,
    await tokenFor(WATCHER_ON_THREE, CARRIER),
  );

  stranger = await connectTo(
    replicas[2].port,
    await tokenFor(STRANGER, OTHER_CARRIER),
  );

  // The connection handler reads the user and the profile before joining any
  // room; measuring before that measures the race.
  await new Promise((done) => setTimeout(done, 2_500));
}, 300_000);

afterAll(async () => {
  for (const socket of [onTwo, onThree, stranger]) socket?.disconnect();

  for (const replica of replicas) replica.process.stdin.end();

  await new Promise((done) => setTimeout(done, 2_000));

  for (const replica of replicas) {
    if (!replica.process.killed) replica.process.kill();
  }

  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [WATCHER_ON_TWO, WATCHER_ON_THREE, STRANGER] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [WATCHER_ON_TWO, WATCHER_ON_THREE, STRANGER] } },
  });
  await prisma.permission.deleteMany({
    where: { profileAccessId: { in: [dispatcherProfile, strangerProfile] } },
  });
  await prisma.profileAccess.deleteMany({
    where: { id: { in: [dispatcherProfile, strangerProfile] } },
  });
  await prisma.business.deleteMany({
    where: { id: { in: [CARRIER, OTHER_CARRIER] } },
  });

  await prisma.$disconnect();
});

describe("node 1 -> event -> node 2", () => {
  it("a rota liberada na réplica 1 chega a quem está na réplica 2", async () => {
    const heard = waitFor(onTwo, "routeEvent");

    await replicas[0].emit("routeEvent", {
      type: "route.released",
      routeId: ROUTE,
      routeCode: 41,
    });

    const event = await heard;

    expect(
      event,
      "o evento não atravessou da réplica 1 para a réplica 2",
    ).not.toBeNull();

    expect(event!.type).toBe("route.released");
    expect(event!.routeCode).toBe(41);
  });

  it("e chega igualmente a quem está na réplica 3", async () => {
    // The same emit, a different node: the adapter reaches every peer, not
    // just the next one.
    const heard = waitFor(onThree, "routeEvent");

    await replicas[0].emit("routeEvent", {
      type: "route.started",
      routeId: ROUTE,
      routeCode: 42,
    });

    const event = await heard;

    expect(
      event,
      "o evento não atravessou da réplica 1 para a réplica 3",
    ).not.toBeNull();

    expect(event!.routeCode).toBe(42);
  });
});

describe("node 2 -> event -> node 3", () => {
  it("a posição emitida na réplica 2 chega a quem está na réplica 3", async () => {
    /**
     * The direction that matters most in practice, and the one that fails
     * silently: the driver's app posts to whichever replica answered, the
     * dispatcher watches from another, and nothing in between logs anything if
     * the frame never crosses.
     */
    const heard = waitFor(onThree, "driverPosition");

    await replicas[1].emit("driverPosition", {
      driverId: DRIVER,
      routeId: ROUTE,
      latitude: -23.55,
      longitude: -46.63,
      speed: 42,
      heading: 180,
      recordedAt: new Date().toISOString(),
    });

    const event = await heard;

    expect(
      event,
      "a posição não atravessou da réplica 2 para a réplica 3",
    ).not.toBeNull();

    expect(event!.latitude).toBe(-23.55);
  });

  it("e quem está na réplica emissora ouve uma vez, não duas", async () => {
    /**
     * An emit reaches local sockets AND remote ones, by two different paths.
     * An adapter that also handed the publisher its own message back would
     * deliver twice on the node that sent it — which on the control tower is a
     * truck drawn in two places a metre apart, flickering, for as long as it
     * drives.
     */
    const seen: unknown[] = [];

    const collect = (payload: unknown) => seen.push(payload);

    onTwo.on("routeEvent", collect);

    await replicas[1].emit("routeEvent", {
      type: "route.completed",
      routeId: ROUTE,
      routeCode: 43,
    });

    await new Promise((done) => setTimeout(done, 3_000));

    onTwo.off("routeEvent", collect);

    expect(seen.length, `o mesmo evento chegou ${seen.length} vezes`).toBe(1);
  });
});

describe("e o alcance continua sendo o da transportadora", () => {
  it("nada atravessa para uma transportadora que não é a do evento", async () => {
    /**
     * The adapter's whole job is to widen the reach of an emit, and widening
     * reach is exactly how a tenant boundary gets crossed by accident. The
     * room is `business:${id}`, so the isolation has to survive the trip — and
     * this is what says it did, rather than assuming it.
     */
    const heard = waitFor(stranger, "routeEvent");

    await replicas[0].emit("routeEvent", {
      type: "route.released",
      routeId: ROUTE,
      routeCode: 44,
    });

    expect(
      await heard,
      "o evento de uma transportadora chegou a outra ao cruzar réplicas",
    ).toBeNull();
  });
});

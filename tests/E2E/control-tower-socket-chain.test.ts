import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
  Before any import reads the environment: the adapter channels of this file,
  shared with the replica it spawns and with nothing else on this Redis (the
  dev API and other suites publish on the same instance).
*/
const ADAPTER_KEY = vi.hoisted(() => {
  const key = `socket.io-e2e-tower-${Math.random().toString(36).slice(2)}`;

  process.env.SOCKET_ADAPTER_KEY = key;

  return key;
});

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { businessToday } from "@/shared/time/business-day";

import { socketClientEntry } from "./support/socket-client";
import { startReplica, type Replica } from "./support/replica-process";

/**
 * A phone reports, the dispatcher's map moves — the whole chain, not a piece
 * of it (TST-2).
 *
 * Every other socket test calls the emitter by hand, so none of them would
 * notice the position use case forgetting to announce, announcing to the
 * wrong room, or announcing before the write. Here the phone's request goes
 * over real HTTP into the real API, the write lands in Postgres, and the only
 * thing asserted is what a connected client receives:
 *
 *   phone ── POST /route/positions ──> API (this process)
 *                                       │ driverPosition, operations:<id>
 *                  ┌────────────────────┴───────────────┐
 *                  ▼                                    ▼ Redis adapter
 *       dispatcher on this node               dispatcher on another replica
 *
 * The second leg is the production shape: the phone and the panel are
 * almost never on the same replica.
 */
const prisma = new PrismaClient();

const CARRIER = "018fe100-0000-7000-8000-00000000000a";
const OTHER = "018fe100-0000-7000-8000-00000000000b";

const DISPATCHER = "018fe100-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018fe100-0000-7000-8000-0000000000a2";
const MASTER = "018fe100-0000-7000-8000-0000000000a3";
const STRANGER = "018fe100-0000-7000-8000-0000000000a4";

const DRIVER = "018fe100-0000-7000-8000-0000000000d1";

interface TestSocket {
  on: Function;
  off: Function;
  emit: Function;
  disconnect: () => void;
}

let connect: (url: string, options: unknown) => TestSocket;

let app: Awaited<typeof import("@/http")>["app"];
let websocket: typeof import("@/websocket");

let apiPort = 0;
let replica: Replica | null = null;

let driverToken = "";
let dispatcherToken = "";
let masterToken = "";
let strangerToken = "";

const sockets: TestSocket[] = [];

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

  return sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
    subject: userId,
    expiresIn: "1h",
  });
}

async function seedBusiness(id: string, cnpj: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `chain-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

function connectTo(port: number, token: string): Promise<TestSocket> {
  return new Promise((done, fail) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(() => fail(new Error(`sem conexão na porta ${port}`)), 20_000);

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

/** One event, or null after the timeout — which is what a "never" is made of. */
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

/** The connection handler reads the database before joining any room. */
const settle = (ms = 1_500) => new Promise((done) => setTimeout(done, ms));

/** What the phone sends: one fresh point, over the network. */
async function report(latitude: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/route/positions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${driverToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      pings: [
        {
          latitude,
          longitude: -46.63,
          accuracy: 10,
          speed: 30,
          heading: 90,
          recorded_at: new Date().toISOString(),
        },
      ],
    }),
  });

  return response.status;
}

beforeAll(async () => {
  await seedBusiness(CARRIER, "11222999000166");
  await seedBusiness(OTHER, "11222999000155");

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista da Cadeia",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-cadeia",
      cpf: "cpf-cadeia",
      rg: "rg-cadeia",
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

  await prisma.user.createMany({
    data: [
      {
        id: DISPATCHER,
        name: "Despachante",
        email: `despacho-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
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
        id: MASTER,
        name: "Suporte",
        email: `master-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
      {
        id: STRANGER,
        name: "Despachante vizinho",
        email: `vizinho-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: OTHER,
      },
    ],
  });

  await prisma.route.create({
    data: {
      code: 4242,
      status: "IN_PROGRESS",
      scheduled_date: businessToday("America/Sao_Paulo"),
      started_at: new Date(Date.now() - 30 * 60 * 1000),
      businessId: CARRIER,
      driverId: DRIVER,
    },
  });

  driverToken = await tokenFor(DRIVER_USER);
  dispatcherToken = await tokenFor(DISPATCHER);
  masterToken = await tokenFor(MASTER);
  strangerToken = await tokenFor(STRANGER);

  // The API as server.ts boots it: HTTP first, then the socket on the same
  // server, with the Redis adapter.
  ({ app } = await import("@/http"));
  await app.listen({ port: 0, host: "127.0.0.1" });
  apiPort = (app.server.address() as { port: number }).port;

  websocket = await import("@/websocket");
  await websocket.initializeSocketIO(app.server);

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));
}, 180_000);

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();

  await replica?.stop();
  await websocket?.shutdownSocketIO();
  await app?.close();
  await prisma.$disconnect();
});

describe("a position posted by the phone", () => {
  it("reaches a dispatcher of the company, and nobody else", async () => {
    const dispatcher = await connectTo(apiPort, dispatcherToken);
    const driver = await connectTo(apiPort, driverToken);
    const stranger = await connectTo(apiPort, strangerToken);

    await settle();

    const heard = waitFor(dispatcher, "driverPosition");
    const driverHeard = waitFor(driver, "driverPosition", 2_500);
    const strangerHeard = waitFor(stranger, "driverPosition", 2_500);

    expect(await report(-23.501)).toBe(200);

    const event = await heard;

    expect(event).toMatchObject({ driverId: DRIVER, latitude: -23.501 });

    // Stored before it was announced: the tower's next read has it.
    const stored = await prisma.driverLastPosition.findUnique({ where: { driverId: DRIVER } });

    expect(stored?.latitude).toBeCloseTo(-23.501, 6);

    expect(await driverHeard).toBeNull();
    expect(await strangerHeard).toBeNull();
  }, 60_000);

  it("reaches a MASTER who subscribed, whatever the case of the id (RT-1)", async () => {
    const master = await connectTo(apiPort, masterToken);

    await settle(500);

    // The rooms are named from database ids, lower case. An upper-case id
    // used to put the socket in a room nobody emits to.
    master.emit("operationsSubscribe", { businessId: CARRIER.toUpperCase() });

    await settle();

    const heard = waitFor(master, "driverPosition");

    expect(await report(-23.502)).toBe(200);

    expect(await heard).toMatchObject({ driverId: DRIVER, latitude: -23.502 });
  }, 60_000);

  it("a status moved by hand reaches the boards as a route event (DLV-MON-4)", async () => {
    const dispatcher = await connectTo(apiPort, dispatcherToken);
    const driver = await connectTo(apiPort, driverToken);

    await settle();

    const heard = waitFor(dispatcher, "routeEvent");
    const driverHeard = waitFor(driver, "routeEvent", 2_500);

    // The emitter the status override calls after its commit: every board
    // already refetches on `routeEvent`, a delivery with no route included.
    websocket.sendDeliveryStatusToBusiness(CARRIER, {
      deliveryId: "018fe100-0000-7000-8000-0000000000e1",
      deliveryStatus: "FAILED",
      routeId: null,
    });

    expect(await heard).toEqual({
      type: "delivery.status_changed",
      deliveryId: "018fe100-0000-7000-8000-0000000000e1",
      deliveryStatus: "FAILED",
      routeId: null,
    });

    // The operations room only: the driver's own copy is another event.
    expect(await driverHeard).toBeNull();
  }, 60_000);

  it("crosses to a dispatcher connected to another replica", async () => {
    replica = await startReplica({
      DATABASE_URL: process.env.DATABASE_URL as string,
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      SOCKET_ADAPTER_KEY: ADAPTER_KEY,
    });

    const elsewhere = await connectTo(replica.port, dispatcherToken);
    const strangerElsewhere = await connectTo(replica.port, strangerToken);

    await settle();

    const heard = waitFor(elsewhere, "driverPosition", 10_000);
    const strangerHeard = waitFor(strangerElsewhere, "driverPosition", 4_000);

    expect(await report(-23.503)).toBe(200);

    expect(await heard).toMatchObject({ driverId: DRIVER, latitude: -23.503 });
    expect(await strangerHeard).toBeNull();
  }, 240_000);
});

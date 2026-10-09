import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { sign } from "jsonwebtoken";

import { socketClientEntry } from "./support/socket-client";
import { startReplica, type Replica } from "./support/replica-process";

/**
 * The `supportTicket` event across replicas (decision 14.5, design §7.3).
 *
 * The ticket changes on whichever replica served the request; the tower and
 * the driver sit on others. This process joins the cluster as the emitting
 * node; two replica processes host the sockets. The event reaches the
 * company's tower on another replica, the driver gets only the reduced view
 * of what changes his conversation, and nothing reaches another company or
 * another driver.
 */
const ADAPTER_KEY = vi.hoisted(() => {
  const key = `socket.io-e2e-ticket-${Math.random().toString(36).slice(2)}`;

  process.env.SOCKET_ADAPTER_KEY = key;

  return key;
});

const prisma = new PrismaClient();

const CARRIER = "018fec00-0000-7000-8000-00000000000a";
const OTHER = "018fec00-0000-7000-8000-00000000000b";

const STAFF = "018fec00-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018fec00-0000-7000-8000-0000000000a2";
const OTHER_DRIVER_USER = "018fec00-0000-7000-8000-0000000000a3";
const FOREIGN_STAFF = "018fec00-0000-7000-8000-0000000000a4";

const DRIVER = "018fec00-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018fec00-0000-7000-8000-0000000000d2";

const NEVER_MS = String(10 * 60 * 1000);

interface TestSocket {
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler: (...args: any[]) => void) => void;
  disconnect: () => void;
}

let connect: (url: string, options: unknown) => TestSocket;

const replicas: Replica[] = [];
let one: Replica;
let two: Replica;

let node: typeof import("@/websocket");
let nodeServer: Server;

const sockets: TestSocket[] = [];

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function tokenFor(userId: string, businessId: string, driverId: string | null) {
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
    { tokenType: "access", role: "BUSINESS_USER", businessId, driverId, sessionVersion: 0, familyId },
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

    const timer = setTimeout(() => fail(new Error(`o socket não conectou na porta ${port}`)), 20_000);

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

function next(
  socket: TestSocket,
  event: string,
  matches: (payload: Record<string, any>) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<Record<string, any> | null> {
  return new Promise((done) => {
    const handler = (payload: Record<string, any>) => {
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

async function seedCompany(id: string, name: string): Promise<string> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: name,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(64000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `ticket-replicas-${randomUUID()}@exemplo.com.br`,
    },
  });

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Atendimento",
      businessId: id,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Gerenciar entregas",
            canRead: true,
            canWrite: true,
            businessId: id,
          },
        ],
      },
    },
  });

  return profile.id;
}

async function seedDriver(id: string, name: string) {
  await prisma.driver.create({
    data: {
      id,
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: randomUUID().slice(0, 11),
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
}

const ticket = (version: number) => ({
  id: "ticket-1",
  number: 7,
  kind: "OCCURRENCE",
  status: "OPEN",
  subject: "Cliente ausente — Mercado Sol",
  version,
  assignee: { id: STAFF, name: "Atendente" },
});

const driverView = { id: "ticket-1", number: 7, status: "OPEN", subject: "Cliente ausente — Mercado Sol" };

beforeAll(async () => {
  const profile = await seedCompany(CARRIER, "Transportadora das Réplicas dos Atendimentos");
  const foreignProfile = await seedCompany(OTHER, "Outra Transportadora");

  await seedDriver(DRIVER, "Motorista Um");
  await seedDriver(OTHER_DRIVER, "Motorista Dois");

  await prisma.user.createMany({
    data: [
      {
        id: STAFF,
        name: "Atendente",
        email: `atendente-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: profile,
      },
      {
        id: FOREIGN_STAFF,
        name: "Atendente de outra empresa",
        email: `alheio-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: OTHER,
        profileAccessId: foreignProfile,
      },
      {
        id: DRIVER_USER,
        name: "Motorista Um",
        email: `motorista-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId: DRIVER,
      },
      {
        id: OTHER_DRIVER_USER,
        name: "Motorista Dois",
        email: `motorista2-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId: OTHER_DRIVER,
      },
    ],
  });

  const redis = process.env.REDIS_URL ?? "redis://localhost:6379";

  one = await startReplica({ REDIS_URL: redis, SOCKET_ADAPTER_KEY: ADAPTER_KEY, SOCKET_REVALIDATE_MS: NEVER_MS });
  two = await startReplica({ REDIS_URL: redis, SOCKET_ADAPTER_KEY: ADAPTER_KEY, SOCKET_REVALIDATE_MS: NEVER_MS });

  replicas.push(one, two);

  nodeServer = createServer();
  await new Promise<void>((done) => nodeServer.listen(0, "127.0.0.1", done));

  node = await import("@/websocket");
  await node.initializeSocketIO(nodeServer);

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));
}, 600_000);

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();

  await Promise.all(replicas.map((replica) => replica.stop()));

  await node?.shutdownSocketIO();
  await new Promise<void>((done) => nodeServer?.close(() => done()));

  await prisma.$disconnect();
}, 60_000);

describe("supportTicket across replicas", () => {
  it(
    "reaches the tower and the ticket's driver on other replicas, and nobody else",
    { timeout: 90_000 },
    async () => {
      const staff = await connectTo(one.port, await tokenFor(STAFF, CARRIER, null));
      const foreignStaff = await connectTo(one.port, await tokenFor(FOREIGN_STAFF, OTHER, null));
      const driver = await connectTo(two.port, await tokenFor(DRIVER_USER, CARRIER, DRIVER));
      const otherDriver = await connectTo(two.port, await tokenFor(OTHER_DRIVER_USER, CARRIER, OTHER_DRIVER));

      // Rooms are joined after the handshake's queries.
      await sleep(2_000);

      const towerHears = next(staff, "supportTicket", (event) => event.type === "ticket.opened");
      const driverHears = next(driver, "supportTicket", (event) => event.type === "ticket.opened");
      const foreignHears = next(foreignStaff, "supportTicket");
      const otherDriverHears = next(otherDriver, "supportTicket");

      node.sendSupportTicketEvent(
        CARRIER,
        DRIVER_USER,
        {
          type: "ticket.opened",
          ticket: ticket(1),
          actor: { id: DRIVER_USER, name: "Motorista Um" },
          alert: { reason: "AUTHORIZATION", driverName: "Motorista Um" },
        },
        driverView,
      );

      const [tower, ownDriver, foreign, other] = await Promise.all([
        towerHears,
        driverHears,
        foreignHears,
        otherDriverHears,
      ]);

      expect(tower).toMatchObject({
        type: "ticket.opened",
        ticket: { id: "ticket-1", version: 1, assignee: { id: STAFF } },
        alert: { reason: "AUTHORIZATION" },
      });

      // The driver's view: never the assignee nor the actor inside the company.
      expect(ownDriver).toEqual({ type: "ticket.opened", ticket: driverView });
      expect(foreign).toBeNull();
      expect(other).toBeNull();
    },
  );

  it("keeps the assignee juggling inside the tower", { timeout: 60_000 }, async () => {
    const staff = await connectTo(two.port, await tokenFor(STAFF, CARRIER, null));
    const driver = await connectTo(one.port, await tokenFor(DRIVER_USER, CARRIER, DRIVER));

    await sleep(2_000);

    const towerHears = next(staff, "supportTicket", (event) => event.type === "ticket.assigned");
    const driverHears = next(driver, "supportTicket", (event) => event.type === "ticket.assigned");

    node.sendSupportTicketEvent(
      CARRIER,
      DRIVER_USER,
      { type: "ticket.assigned", ticket: ticket(2), actor: { id: STAFF, name: "Atendente" } },
      driverView,
    );

    expect(await towerHears).toMatchObject({ type: "ticket.assigned", ticket: { version: 2 } });
    expect(await driverHears).toBeNull();
  });
});

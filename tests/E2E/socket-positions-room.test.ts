import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import {
  operationsRoom,
  positionsRoom,
} from "@/shared/socket/operations-access";

import { socketClientEntry } from "./support/socket-client";
import { emitHandled, waitForRoom, waitUntil } from "./support/socket-waits";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The positions room (plano-escala U-01, F2.19), through the real channel.
 *
 * Every web tab of the dispatch team is put in its company's operations
 * room at connect, and the operations room carried every truck's position
 * every few seconds, on any page of the panel. Only the tower and a route's
 * detail draw the dots: they subscribe to `positions:<businessId>`, under
 * the operations room's rule (`canWatchOperationsOf`), and the fleet's GPS
 * leaves the operations room once U-03 turns
 * SOCKET_POSITIONS_ON_OPERATIONS_ROOM off.
 *
 * Who may be in it is the property, so every case that joins has a
 * counterpart that must not: a driver (whose profile grants
 * delivery_manage), a colleague without it, a dispatcher asking for another
 * company. And while both rooms get the position, a tab in both hears it
 * once: one emit to two rooms, which the web's dedupe (X-32) is only the
 * belt for.
 */
const prisma = createPrismaClient();

const CARRIER = "018fd1a0-0000-7000-8000-00000000000a";
const OTHER_CARRIER = "018fd1a0-0000-7000-8000-00000000000b";

const DISPATCHER = "018fd1a0-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018fd1a0-0000-7000-8000-0000000000a2";
const MECHANIC = "018fd1a0-0000-7000-8000-0000000000a3";
const MASTER = "018fd1a0-0000-7000-8000-0000000000a4";

const DRIVER = "018fd1a0-0000-7000-8000-0000000000d1";
const ROUTE = "018fd1a0-0000-7000-8000-0000000000e1";

const USERS = [DISPATCHER, DRIVER_USER, MECHANIC, MASTER];

let server: Server;
let port = 0;

let io: typeof import("@/websocket");
let ioServer: Awaited<
  ReturnType<typeof import("@/websocket").initializeSocketIO>
>;

let dispatcherProfile = "";
let mechanicProfile = "";

interface TestSocket {
  id: string;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  off: (event: string, listener: (...args: any[]) => void) => unknown;
  disconnect: () => void;
  emit: (...args: unknown[]) => unknown;
  connected: boolean;
}

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
      cnpj: `${Date.now()}${Math.floor(Math.random() * 10)}`
        .slice(-14)
        .padStart(14, "8"),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `positions-${randomUUID()}@exemplo.com.br`,
    },
  });
}

async function seedProfile(
  businessId: string,
  name: string,
  permissionKey: string,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name,
      businessId,
      permissions: {
        create: [
          {
            permissionKey,
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

async function tokenFor(
  userId: string,
  role: string,
  businessId: string | null,
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
      role,
      businessId,
      driverId,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

const position = (recordedAt = new Date().toISOString()) => ({
  driverId: DRIVER,
  routeId: ROUTE,
  latitude: -23.55,
  longitude: -46.63,
  speed: 42,
  heading: 180,
  recordedAt,
});

/** Whether the server has this socket in the room, from its own index. */
const inRoom = (socket: TestSocket, room: string) =>
  ioServer.of("/").adapter.rooms.get(room)?.has(socket.id) ?? false;

let dispatcher: TestSocket;
let driver: TestSocket;
let mechanic: TestSocket;
let master: TestSocket;

beforeAll(async () => {
  await seedBusiness(CARRIER, "Transportadora das Posições");
  await seedBusiness(OTHER_CARRIER, "Transportadora Vizinha das Posições");

  dispatcherProfile = await seedProfile(CARRIER, "Despacho", "delivery_manage");
  mechanicProfile = await seedProfile(CARRIER, "Oficina", "fuel_manage");

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista das Posições",
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: String(Date.now()).slice(-11),
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

  await prisma.user.createMany({
    data: [
      {
        id: DISPATCHER,
        name: "Despachante",
        email: `despacho-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: dispatcherProfile,
      },
      {
        id: DRIVER_USER,
        name: "Motorista",
        email: `motorista-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId: DRIVER,
        // The driver profile grants delivery_manage, on purpose: reading it
        // as "may watch the fleet" is the mistake the rule refuses.
        profileAccessId: dispatcherProfile,
      },
      {
        id: MECHANIC,
        name: "Mecânico",
        email: `oficina-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: mechanicProfile,
      },
      {
        id: MASTER,
        name: "Suporte Trajetto",
        email: `master-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
    ],
  });

  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;

  io = await import("@/websocket");
  ioServer = await io.initializeSocketIO(server);

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));

  dispatcher = await connectAs(
    await tokenFor(DISPATCHER, "BUSINESS_USER", CARRIER, null),
  );
  driver = await connectAs(
    await tokenFor(DRIVER_USER, "BUSINESS_USER", CARRIER, DRIVER),
  );
  mechanic = await connectAs(
    await tokenFor(MECHANIC, "BUSINESS_USER", CARRIER, null),
  );
  master = await connectAs(await tokenFor(MASTER, "MASTER", null, null));

  // The web's dispatcher is in the operations room from the connect on.
  await waitForRoom(ioServer, dispatcher.id, operationsRoom(CARRIER), true);
}, 180_000);

afterAll(async () => {
  for (const socket of [dispatcher, driver, mechanic, master]) {
    socket?.disconnect();
  }

  await io?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));

  await prisma.refreshToken.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
  await prisma.driver.deleteMany({ where: { id: DRIVER } });
  await prisma.permission.deleteMany({
    where: { profileAccessId: { in: [dispatcherProfile, mechanicProfile] } },
  });
  await prisma.profileAccess.deleteMany({
    where: { id: { in: [dispatcherProfile, mechanicProfile] } },
  });
  await prisma.business.deleteMany({
    where: { id: { in: [CARRIER, OTHER_CARRIER] } },
  });

  await prisma.$disconnect();
});

describe("the positions room", () => {
  it("is joined by nobody at connect", () => {
    // Only the screens that draw the dots ask for it.
    for (const socket of [dispatcher, driver, mechanic, master]) {
      expect(inRoom(socket, positionsRoom(CARRIER))).toBe(false);
    }
  });

  it("takes the dispatcher who subscribes to their own company", async () => {
    await emitHandled(dispatcher, "positionsSubscribe", {
      businessId: CARRIER,
    });

    expect(inRoom(dispatcher, positionsRoom(CARRIER))).toBe(true);
  });

  it("refuses a driver, whatever their profile grants", async () => {
    await emitHandled(driver, "positionsSubscribe", { businessId: CARRIER });

    expect(inRoom(driver, positionsRoom(CARRIER))).toBe(false);
  });

  it("refuses a colleague without delivery permission", async () => {
    await emitHandled(mechanic, "positionsSubscribe", { businessId: CARRIER });

    expect(inRoom(mechanic, positionsRoom(CARRIER))).toBe(false);
  });

  it("refuses another company to a dispatcher, who keeps their own", async () => {
    await emitHandled(dispatcher, "positionsSubscribe", {
      businessId: OTHER_CARRIER,
    });

    expect(inRoom(dispatcher, positionsRoom(OTHER_CARRIER))).toBe(false);
    expect(inRoom(dispatcher, positionsRoom(CARRIER))).toBe(true);
  });

  it("takes a MASTER into the company they follow, one company at a time", async () => {
    await emitHandled(master, "positionsSubscribe", { businessId: CARRIER });

    expect(inRoom(master, positionsRoom(CARRIER))).toBe(true);

    await emitHandled(master, "positionsSubscribe", {
      businessId: OTHER_CARRIER,
    });

    // Stacking rooms across a switch would put another tenant's trucks on
    // the map.
    expect(inRoom(master, positionsRoom(OTHER_CARRIER))).toBe(true);
    expect(inRoom(master, positionsRoom(CARRIER))).toBe(false);
  });
});

describe("a driver's position", () => {
  it("reaches a tab in both rooms once, in one broadcast", async () => {
    const heard: Array<{ recordedAt: string }> = [];
    const collect = (payload: { recordedAt: string }) => heard.push(payload);

    dispatcher.on("driverPosition", collect);

    // In both rooms while SOCKET_POSITIONS_ON_OPERATIONS_ROOM is on (the
    // default).
    expect(inRoom(dispatcher, operationsRoom(CARRIER))).toBe(true);
    expect(inRoom(dispatcher, positionsRoom(CARRIER))).toBe(true);

    const first = new Date(Date.now() - 1_000).toISOString();
    const marker = new Date().toISOString();

    // One emit to the two rooms is what makes "once" hold: Socket.IO sends a
    // socket in both one copy. Two emits, one per room, would also look
    // like once on the wire, because the second volatile frame of the same
    // tick is dropped while the first is still being written; so the
    // broadcast itself is what is asserted.
    const to = vi.spyOn(ioServer, "to");

    io.sendDriverPositionToBusiness(CARRIER, position(first));

    expect(to).toHaveBeenCalledTimes(1);
    expect(to.mock.calls[0][0]).toEqual([
      positionsRoom(CARRIER),
      operationsRoom(CARRIER),
    ]);

    to.mockRestore();

    await waitUntil(
      () => heard.some((event) => event.recordedAt === first),
      "a posição chegar",
    );

    // Frames reach one socket in order: once the marker is here, a second
    // copy of the first would have arrived already.
    io.sendDriverPositionToBusiness(CARRIER, position(marker));

    await waitUntil(
      () => heard.some((event) => event.recordedAt === marker),
      "a posição de marcação chegar",
    );

    dispatcher.off("driverPosition", collect);

    expect(heard.map((event) => event.recordedAt)).toEqual([first, marker]);
  });

  it("reaches the MASTER following that company, and not another one", async () => {
    // The MASTER follows OTHER_CARRIER now (above).
    const heard: string[] = [];
    const collect = (payload: { driverId: string }) =>
      heard.push(payload.driverId);

    master.on("driverPosition", collect);

    io.sendDriverPositionToBusiness(CARRIER, position());
    io.sendDriverPositionToBusiness(OTHER_CARRIER, {
      ...position(),
      driverId: "018fd1a0-0000-7000-8000-0000000000d2",
    });

    await waitUntil(() => heard.length > 0, "a posição da empresa seguida");

    master.off("driverPosition", collect);

    expect(heard).toEqual(["018fd1a0-0000-7000-8000-0000000000d2"]);
  });
});

describe("leaving the room", () => {
  it("happens on an unsubscribe", async () => {
    await emitHandled(master, "positionsUnsubscribe", {
      businessId: OTHER_CARRIER,
    });

    expect(inRoom(master, positionsRoom(OTHER_CARRIER))).toBe(false);
  });

  it("happens when the dispatcher loses the permission, without losing the connection", async () => {
    await prisma.permission.updateMany({
      where: {
        profileAccessId: dispatcherProfile,
        permissionKey: "delivery_manage",
      },
      data: { canRead: false, canWrite: false },
    });

    io.sendSecurityEventToBusiness(CARRIER, { reason: "permissions_changed" });

    await waitForRoom(ioServer, dispatcher.id, positionsRoom(CARRIER), false);

    expect(dispatcher.connected).toBe(true);
    expect(inRoom(dispatcher, operationsRoom(CARRIER))).toBe(false);
  }, 30_000);
});

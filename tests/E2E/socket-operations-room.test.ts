import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { socketClientEntry } from "./support/socket-client";

/**
 * Who hears where the trucks are.
 *
 * `business:${businessId}` was joined by EVERY authenticated socket that had a
 * company, with no permission check of any kind — and two of the events sent
 * into it were `driverPosition` and `routeEvent`. So a driver received every
 * colleague's GPS coordinates, every few seconds, for as long as their app was
 * open; and so did a user whose profile only granted `fuel_manage`.
 *
 * The HTTP side had refused this the whole time: `/route/control-tower` sits
 * behind `delivery_manage:read` and refuses a driver token outright. The
 * socket never asked the question at all.
 *
 * Three connections, one company, one event — that is the shape of the proof.
 * Asserting only that the dispatcher receives would pass just as well with the
 * old code, so every test here has a counterpart that must NOT receive.
 */
const prisma = new PrismaClient();

const CARRIER = "018fd100-0000-7000-8000-00000000000a";
const OTHER_CARRIER = "018fd100-0000-7000-8000-00000000000b";

const DISPATCHER = "018fd100-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018fd100-0000-7000-8000-0000000000a2";
const MECHANIC = "018fd100-0000-7000-8000-0000000000a3";
const MASTER = "018fd100-0000-7000-8000-0000000000a4";

const DRIVER = "018fd100-0000-7000-8000-0000000000d1";
const ROUTE = "018fd100-0000-7000-8000-0000000000r1";

let server: Server;
let port = 0;

let io: typeof import("@/websocket");

let dispatcherProfile = "";
let mechanicProfile = "";

interface TestSocket {
  on: Function;
  off: Function;
  removeAllListeners: Function;
  disconnect: () => void;
  emit: Function;
  connected: boolean;
}

let connect: (url: string, options: unknown) => TestSocket;

async function loadClient(): Promise<void> {
  const entry = socketClientEntry();

  ({ io: connect } = await import(/* @vite-ignore */ entry));
}

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
 * Listens for one event, or gives up.
 *
 * The timeout is what a negative assertion is made of, so it is generous:
 * a room join that is merely SLOW would otherwise read as a room join that
 * did not happen, and the test would pass for the wrong reason.
 */
function waitFor(
  socket: TestSocket,
  event: string,
  timeoutMs = 2500,
): Promise<unknown | null> {
  return new Promise((done) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      done(null);
    }, timeoutMs);

    const handler = (payload: unknown) => {
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
      cnpj: String(Date.now()).slice(-14).padStart(14, "9"),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `ops-${randomUUID()}@exemplo.com.br`,
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
    { tokenType: "access", role, businessId, driverId, sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

const position = () => ({
  driverId: DRIVER,
  routeId: ROUTE,
  latitude: -23.55,
  longitude: -46.63,
  speed: 42,
  heading: 180,
  recordedAt: new Date().toISOString(),
});

const routeEvent = () =>
  ({ type: "route.started", routeId: ROUTE, routeCode: 7 }) as never;

let dispatcher: TestSocket;
let driver: TestSocket;
let mechanic: TestSocket;
let master: TestSocket;

beforeAll(async () => {
  await seedBusiness(CARRIER, "Transportadora da Operação");
  await seedBusiness(OTHER_CARRIER, "Transportadora Vizinha");

  dispatcherProfile = await seedProfile(CARRIER, "Despacho", "delivery_manage");
  mechanicProfile = await seedProfile(CARRIER, "Oficina", "fuel_manage");

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista da Operação",
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

        // Deliberate: the driver profile grants delivery_manage, because the
        // app needs it to list the day's work. Reading that key as "may watch
        // the whole fleet" is exactly the mistake under test.
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
  await io.initializeSocketIO(server);

  await loadClient();

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

  // The connection handler reads the user, the driver and the refresh family
  // before joining any room. Measuring before that measures the race.
  await new Promise((done) => setTimeout(done, 1800));
}, 180_000);

afterAll(async () => {
  for (const socket of [dispatcher, driver, mechanic, master]) {
    socket?.disconnect();
  }

  await io?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));

  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [DISPATCHER, DRIVER_USER, MECHANIC, MASTER] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [DISPATCHER, DRIVER_USER, MECHANIC, MASTER] } },
  });
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

describe("a driver's position", () => {
  it("reaches the dispatcher", async () => {
    const received = waitFor(dispatcher, "driverPosition");

    io.sendDriverPositionToBusiness(CARRIER, position());

    expect(await received).toMatchObject({ driverId: DRIVER });
  });

  it("does not reach another driver", async () => {
    // The leak, in one line. A phone in the cab was receiving the coordinates
    // of every other truck in the fleet — and the app needs `delivery_manage`
    // to work, so no permission change could have stopped it.
    const received = waitFor(driver, "driverPosition");

    io.sendDriverPositionToBusiness(CARRIER, position());

    expect(await received).toBeNull();
  });

  it("does not reach a colleague without delivery permission", async () => {
    const received = waitFor(mechanic, "driverPosition");

    io.sendDriverPositionToBusiness(CARRIER, position());

    expect(await received).toBeNull();
  });
});

describe("a route event", () => {
  it("reaches the dispatcher", async () => {
    const received = waitFor(dispatcher, "routeEvent");

    io.sendRouteEventToBusiness(CARRIER, routeEvent());

    expect(await received).toMatchObject({ routeId: ROUTE });
  });

  it("does not reach a driver through the company room", async () => {
    // The driver DOES get their own route events — through `user:${id}`, from
    // `sendRouteEventToDriver`. What they must not get is everybody's.
    const received = waitFor(driver, "routeEvent");

    io.sendRouteEventToBusiness(CARRIER, routeEvent());

    expect(await received).toBeNull();
  });

  it("still reaches the driver when it is addressed to them", async () => {
    const received = waitFor(driver, "routeEvent");

    io.sendRouteEventToDriver(DRIVER_USER, routeEvent());

    expect(await received).toMatchObject({ routeId: ROUTE });
  });
});

describe("the company room is still everybody's", () => {
  /**
   * The other half of the change, and the one a careless fix would break.
   *
   * `business:` was not replaced — it still carries what genuinely concerns
   * every login of the tenant. Moving those into the permissioned room would
   * mean a driver never learning that their company's plan changed.
   */
  it("delivers a plan change to the driver and to the mechanic", async () => {
    const atDriver = waitFor(driver, "entitlementsChanged");
    const atMechanic = waitFor(mechanic, "entitlementsChanged");

    io.sendEntitlementsChangedEvent(CARRIER, {
      module: "deliveries",
      enabled: false,
    });

    expect(await atDriver).toMatchObject({ module: "deliveries" });
    expect(await atMechanic).toMatchObject({ module: "deliveries" });
  });
});

describe("a MASTER following a company", () => {
  it("hears nothing until it subscribes", async () => {
    // A master belongs to no company, so the server cannot guess which
    // operation they are looking at. Before this change there was no way to
    // ask, either — the tower simply had no live dots for a master seat.
    const received = waitFor(master, "driverPosition");

    io.sendDriverPositionToBusiness(CARRIER, position());

    expect(await received).toBeNull();
  });

  it("hears the operation it subscribed to", async () => {
    master.emit("operationsSubscribe", { businessId: CARRIER });

    await new Promise((done) => setTimeout(done, 400));

    const received = waitFor(master, "driverPosition");

    io.sendDriverPositionToBusiness(CARRIER, position());

    expect(await received).toMatchObject({ driverId: DRIVER });
  });

  it("stops hearing the first one when it switches company", async () => {
    // One socket watches exactly one operation. Stacking rooms across a
    // switch in the selector would put another tenant's trucks on the map.
    master.emit("operationsSubscribe", { businessId: OTHER_CARRIER });

    await new Promise((done) => setTimeout(done, 400));

    const received = waitFor(master, "driverPosition");

    io.sendDriverPositionToBusiness(CARRIER, position());

    expect(await received).toBeNull();
  });
});

describe("a user who is not a MASTER cannot subscribe past their company", () => {
  it("is ignored when it asks for another tenant", async () => {
    dispatcher.emit("operationsSubscribe", { businessId: OTHER_CARRIER });

    await new Promise((done) => setTimeout(done, 400));

    const received = waitFor(dispatcher, "driverPosition");

    io.sendDriverPositionToBusiness(OTHER_CARRIER, position());

    expect(await received).toBeNull();
  });

  it("and keeps its own", async () => {
    // Silent refusal must not cost them the room they legitimately hold: the
    // handler leaves the previous room BEFORE checking, in a careless
    // implementation.
    const received = waitFor(dispatcher, "driverPosition");

    io.sendDriverPositionToBusiness(CARRIER, position());

    expect(await received).toMatchObject({ driverId: DRIVER });
  });

  it("is ignored when a driver asks for their own company", async () => {
    driver.emit("operationsSubscribe", { businessId: CARRIER });

    await new Promise((done) => setTimeout(done, 400));

    const received = waitFor(driver, "driverPosition");

    io.sendDriverPositionToBusiness(CARRIER, position());

    expect(await received).toBeNull();
  });
});

describe("when the dispatcher loses the permission mid-connection", () => {
  it("stops receiving positions, without losing the connection", async () => {
    await prisma.permission.updateMany({
      where: { profileAccessId: dispatcherProfile, permissionKey: "delivery_manage" },
      data: { canRead: false, canWrite: false },
    });

    io.sendSecurityEventToBusiness(CARRIER, { reason: "permissions_changed" });

    // The re-evaluation reads the database once per connected socket.
    await new Promise((done) => setTimeout(done, 2000));

    const received = waitFor(dispatcher, "driverPosition");

    io.sendDriverPositionToBusiness(CARRIER, position());

    expect(await received).toBeNull();

    const online = await io.getOnlineUserIds([DISPATCHER]);
    expect(online).toContain(DISPATCHER);
  }, 30_000);

  it("and route events go quiet too, not only positions", async () => {
    /**
     * Two different emitters go into the same room, and the first version of
     * this file only asked about one of them.
     *
     * `sendDriverPositionToBusiness` and `sendRouteEventToBusiness` both
     * address `operations:${businessId}`, so leaving the room silences both —
     * but that is an argument, not a measurement. A room left for positions
     * and not for routes would have looked exactly like this test passing.
     */
    const received = waitFor(dispatcher, "routeEvent");

    io.sendRouteEventToBusiness(CARRIER, {
      type: "route.released",
      routeId: ROUTE,
      businessId: CARRIER,
      driverId: DRIVER,
    } as never);

    expect(await received).toBeNull();
  }, 30_000);
});

describe("when a MASTER is demoted mid-connection", () => {
  it("loses the connection, and with it the company it was following", async () => {
    /**
     * The one the company-scoped re-evaluation cannot reach.
     *
     * `refreshDeliveryRooms` walks `business:${businessId}` — and a MASTER has
     * no company, so it never joins that room and the sweep never sees it. A
     * MASTER watching a carrier's operation is therefore NOT re-evaluated by a
     * permission change in that carrier, which is correct: their authority
     * does not come from there.
     *
     * What does reach them is a change to their OWN user. Every security field
     * — role, company, profile, driver link — fires `user_updated`, and that
     * reason is not on the authorization-only list, so the session ends and
     * the sockets are dropped. This is the test that says the door that
     * exists is the door that closes.
     */
    master.emit("operationsSubscribe", { businessId: CARRIER });

    // The subscription is a round trip: the server checks the role before
    // joining anything.
    await new Promise((done) => setTimeout(done, 1200));

    const before = waitFor(master, "routeEvent");

    io.sendRouteEventToBusiness(CARRIER, {
      type: "route.released",
      routeId: ROUTE,
      businessId: CARRIER,
      driverId: DRIVER,
    } as never);

    expect(
      await before,
      "o MASTER não estava ouvindo; o teste mediria silêncio de graça",
    ).not.toBeNull();

    // The demotion, as the product does it: any security field changing on the
    // user fires this.
    io.sendSecurityEventToUser(MASTER, { reason: "user_updated" });

    await new Promise((done) => setTimeout(done, 1500));

    expect(
      master.connected,
      "o MASTER rebaixado continuou conectado",
    ).toBe(false);

    const after = waitFor(master, "routeEvent");

    io.sendRouteEventToBusiness(CARRIER, {
      type: "route.released",
      routeId: ROUTE,
      businessId: CARRIER,
      driverId: DRIVER,
    } as never);

    expect(await after).toBeNull();
  }, 30_000);
});

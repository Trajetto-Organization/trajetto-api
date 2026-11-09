import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { operationsRoom } from "@/shared/socket/operations-access";
import { chatStaffRoom } from "@/modules/chat/usecases/shared/chat-access-rules";

import { socketClientEntry } from "./support/socket-client";
import { emitHandled, waitForRoom } from "./support/socket-waits";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The app's socket joins the dispatch rooms only when a screen asks (wave 4).
 *
 * Every admin or operator socket was put in its company's operations and SAC
 * rooms at connect. That is the web's tower and chat; on the app it meant the
 * fleet's positions, route events and chat reaching a phone that threw them
 * away. The app now says it is the app — the `x-trajetto-client: mobile`
 * header it already sends over HTTP, or `client: "mobile"` in the handshake
 * payload — and joins on `operationsSubscribe` and leaves on
 * `operationsUnsubscribe`, its own company's room included. The web is
 * unchanged: auto-join at connect, and the lock that keeps its own room.
 *
 * Every positive case has its negative, as in socket-operations-room.test.ts:
 * a mobile socket that hears nothing proves little unless the web one beside
 * it hears the same event.
 */
const prisma = createPrismaClient();

const CARRIER = "018feb00-0000-7000-8000-00000000000a";
const OTHER_CARRIER = "018feb00-0000-7000-8000-00000000000b";

const ADMIN = "018feb00-0000-7000-8000-0000000000a1";
const DISPATCHER = "018feb00-0000-7000-8000-0000000000a2";
const MASTER = "018feb00-0000-7000-8000-0000000000a3";

const DRIVER = "018feb00-0000-7000-8000-0000000000d1";
const ROUTE = "018feb00-0000-7000-8000-0000000000b1";

let server: Server;
let port = 0;

let io: typeof import("@/websocket");
let ioServer: Awaited<
  ReturnType<typeof import("@/websocket").initializeSocketIO>
>;

let dispatcherProfile = "";

interface TestSocket {
  id: string;
  on: Function;
  off: Function;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeAllListeners: Function;
  disconnect: () => void;
  emit: (...args: unknown[]) => unknown;
  connected: boolean;
}

let connect: (url: string, options: unknown) => TestSocket;

async function loadClient(): Promise<void> {
  const entry = socketClientEntry();

  ({ io: connect } = await import(/* @vite-ignore */ entry));
}

type Declared = "web" | "mobile-header" | "mobile-auth";

function connectAs(token: string, declared: Declared): Promise<TestSocket> {
  return new Promise((done, reject) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth:
        declared === "mobile-auth" ? { token, client: "mobile" } : { token },
      // The app's header, the same one every HTTP call of the app carries.
      extraHeaders:
        declared === "mobile-header"
          ? { "x-trajetto-client": "mobile" }
          : undefined,
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

/** One event, or null after a generous wait (a negative assertion). */
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
      cnpj: `${Date.now()}${Math.floor(Math.random() * 10)}`
        .slice(-14)
        .padStart(14, "8"),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `mobile-${randomUUID()}@exemplo.com.br`,
    },
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
    { tokenType: "access", sessionVersion: 0, familyId },
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

const authorization = () =>
  ({
    type: "occurrence.authorization_requested",
    occurrenceId: randomUUID(),
    deliveryId: randomUUID(),
    status: "PENDING",
  }) as const;

let webAdmin: TestSocket;
let mobileAdmin: TestSocket;
let mobileDispatcher: TestSocket;
let mobileMaster: TestSocket;

beforeAll(async () => {
  await seedBusiness(CARRIER, "Transportadora do App");
  await seedBusiness(OTHER_CARRIER, "Transportadora Vizinha do App");

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
            canWrite: true,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  dispatcherProfile = profile.id;

  await prisma.user.createMany({
    data: [
      {
        id: ADMIN,
        name: "Administradora",
        email: `admin-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
      },
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

  await loadClient();

  webAdmin = await connectAs(await tokenFor(ADMIN), "web");
  mobileAdmin = await connectAs(await tokenFor(ADMIN), "mobile-header");
  mobileDispatcher = await connectAs(await tokenFor(DISPATCHER), "mobile-auth");
  mobileMaster = await connectAs(await tokenFor(MASTER), "mobile-header");

  // The connection handler joins the user room before the dispatch rooms
  // decision: once it is there, whatever was going to be joined at connect
  // has been.
  await waitForRoom(ioServer, webAdmin.id, operationsRoom(CARRIER), true);

  for (const [socket, userId] of [
    [mobileAdmin, ADMIN],
    [mobileDispatcher, DISPATCHER],
    [mobileMaster, MASTER],
  ] as const) {
    await waitForRoom(ioServer, socket.id, `user:${userId}`, true);
  }
}, 180_000);

afterAll(async () => {
  for (const socket of [
    webAdmin,
    mobileAdmin,
    mobileDispatcher,
    mobileMaster,
  ]) {
    socket?.disconnect();
  }

  await io?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));

  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [ADMIN, DISPATCHER, MASTER] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [ADMIN, DISPATCHER, MASTER] } },
  });
  await prisma.permission.deleteMany({
    where: { profileAccessId: dispatcherProfile },
  });
  await prisma.profileAccess.deleteMany({ where: { id: dispatcherProfile } });
  await prisma.business.deleteMany({
    where: { id: { in: [CARRIER, OTHER_CARRIER] } },
  });

  await prisma.$disconnect();
});

const rooms = (socketId: string) => [
  ...(ioServer.of("/").sockets.get(socketId)?.rooms ?? []),
];

describe("at connect", () => {
  it("the web socket joins its company's operations and SAC rooms, as before", () => {
    expect(rooms(webAdmin.id)).toEqual(
      expect.arrayContaining([
        `user:${ADMIN}`,
        `business:${CARRIER}`,
        operationsRoom(CARRIER),
        chatStaffRoom(CARRIER),
      ]),
    );
  });

  it("the app's socket joins neither, by header or by handshake payload", () => {
    for (const socket of [mobileAdmin, mobileDispatcher]) {
      const joined = rooms(socket.id);

      // The company room stays: plan changes and security actions reach
      // every login, the app's included.
      expect(joined).toContain(`business:${CARRIER}`);
      expect(joined).not.toContain(operationsRoom(CARRIER));
      expect(joined).not.toContain(chatStaffRoom(CARRIER));
    }
  });

  it("so a position reaches the web and not the phone in the pocket", async () => {
    const atWeb = waitFor(webAdmin, "driverPosition");
    const atPhone = waitFor(mobileAdmin, "driverPosition");

    io.sendDriverPositionToBusiness(CARRIER, position());

    expect(await atWeb).toMatchObject({ driverId: DRIVER });
    expect(await atPhone).toBeNull();
  });

  it("nor does a chat message to the SAC", async () => {
    const atWeb = waitFor(webAdmin, "chatMessage");
    const atPhone = waitFor(mobileDispatcher, "chatMessage");

    io.sendChatMessageEvent(CARRIER, null, {
      id: randomUUID(),
      body: "Cheguei",
    });

    expect(await atWeb).not.toBeNull();
    expect(await atPhone).toBeNull();
  });
});

describe("the app's operations screen", () => {
  it("hears the operation once it subscribes, the authorization queue included", async () => {
    await emitHandled(mobileAdmin, "operationsSubscribe", {
      businessId: CARRIER,
    });

    expect(rooms(mobileAdmin.id)).toContain(operationsRoom(CARRIER));

    const queued = waitFor(mobileAdmin, "occurrenceAuthorization");
    io.sendOccurrenceAuthorizationToBusiness(CARRIER, authorization());
    expect(await queued).toMatchObject({ status: "PENDING" });

    const moved = waitFor(mobileAdmin, "driverPosition");
    io.sendDriverPositionToBusiness(CARRIER, position());
    expect(await moved).toMatchObject({ driverId: DRIVER });
  });

  it("gives its own company's room back on unsubscribe", async () => {
    await emitHandled(mobileAdmin, "operationsUnsubscribe", {
      businessId: CARRIER,
    });

    expect(rooms(mobileAdmin.id)).not.toContain(operationsRoom(CARRIER));

    const received = waitFor(mobileAdmin, "occurrenceAuthorization");
    io.sendOccurrenceAuthorizationToBusiness(CARRIER, authorization());
    expect(await received).toBeNull();
  });

  it("is refused another company, without losing the connection", async () => {
    await emitHandled(mobileDispatcher, "operationsSubscribe", {
      businessId: OTHER_CARRIER,
    });

    expect(rooms(mobileDispatcher.id)).not.toContain(
      operationsRoom(OTHER_CARRIER),
    );
    expect(mobileDispatcher.connected).toBe(true);

    // Its own, with the profile's read key, is allowed.
    await emitHandled(mobileDispatcher, "operationsSubscribe", {
      businessId: CARRIER,
    });

    expect(rooms(mobileDispatcher.id)).toContain(operationsRoom(CARRIER));

    await emitHandled(mobileDispatcher, "operationsUnsubscribe", {
      businessId: CARRIER,
    });

    expect(rooms(mobileDispatcher.id)).not.toContain(operationsRoom(CARRIER));
  });

  it("follows the MASTER's selected company and leaves it", async () => {
    await emitHandled(mobileMaster, "operationsSubscribe", {
      businessId: CARRIER,
    });

    expect(rooms(mobileMaster.id)).toContain(operationsRoom(CARRIER));

    await emitHandled(mobileMaster, "operationsUnsubscribe", {
      businessId: CARRIER,
    });

    expect(rooms(mobileMaster.id)).not.toContain(operationsRoom(CARRIER));
  });
});

describe("a subscribe and an unsubscribe sent back to back", () => {
  // A fresh socket each time: its first staff check is a query, so the
  // unsubscribe lands while the subscribe still waits on the database. That
  // is the app when a push opens a screen over the operations tab: focus,
  // then blur a few milliseconds later. The unsubscribe used to find no room
  // to leave, and the late subscribe joined anyway.
  it.each([
    ["operations", "operationsSubscribe", "operationsUnsubscribe"],
    ["SAC", "chatSubscribe", "chatUnsubscribe"],
  ] as const)(
    "leaves the app's socket out of the %s room",
    async (kind, subscribe, unsubscribe) => {
      const phone = await connectAs(await tokenFor(ADMIN), "mobile-header");
      const room =
        kind === "operations"
          ? operationsRoom(CARRIER)
          : chatStaffRoom(CARRIER);

      try {
        await waitForRoom(ioServer, phone.id, `user:${ADMIN}`, true);

        // Both on the wire before either answer: no await in between.
        const subscribed = emitHandled(phone, subscribe, {
          businessId: CARRIER,
        });
        const unsubscribed = emitHandled(phone, unsubscribe, {
          businessId: CARRIER,
        });

        await Promise.all([subscribed, unsubscribed]);

        expect(rooms(phone.id)).not.toContain(room);

        if (kind === "operations") {
          const received = waitFor(phone, "driverPosition");
          io.sendDriverPositionToBusiness(CARRIER, position());
          expect(await received).toBeNull();
        }

        // Cancelling one subscribe is not a refusal: the next one joins.
        await emitHandled(phone, subscribe, { businessId: CARRIER });

        expect(rooms(phone.id)).toContain(room);
      } finally {
        phone.disconnect();
      }
    },
  );

  it("the MASTER switching companies ends in the last one asked for", async () => {
    const phone = await connectAs(await tokenFor(MASTER), "mobile-header");

    try {
      await waitForRoom(ioServer, phone.id, `user:${MASTER}`, true);

      const first = emitHandled(phone, "operationsSubscribe", {
        businessId: CARRIER,
      });
      const second = emitHandled(phone, "operationsSubscribe", {
        businessId: OTHER_CARRIER,
      });

      await Promise.all([first, second]);

      const joined = rooms(phone.id);

      expect(joined).toContain(operationsRoom(OTHER_CARRIER));
      expect(joined).not.toContain(operationsRoom(CARRIER));
    } finally {
      phone.disconnect();
    }
  });
});

describe("the web keeps its lock", () => {
  it("an unsubscribe from its own company's operations room leaves it in place", async () => {
    await emitHandled(webAdmin, "operationsUnsubscribe", {
      businessId: CARRIER,
    });

    expect(rooms(webAdmin.id)).toContain(operationsRoom(CARRIER));

    const received = waitFor(webAdmin, "driverPosition");
    io.sendDriverPositionToBusiness(CARRIER, position());
    expect(await received).toMatchObject({ driverId: DRIVER });
  });

  it("and so does the SAC room", async () => {
    await emitHandled(webAdmin, "chatUnsubscribe", { businessId: CARRIER });

    expect(rooms(webAdmin.id)).toContain(chatStaffRoom(CARRIER));
  });

  it("while the app may leave the SAC room it asked for", async () => {
    await emitHandled(mobileAdmin, "chatSubscribe", { businessId: CARRIER });

    expect(rooms(mobileAdmin.id)).toContain(chatStaffRoom(CARRIER));

    await emitHandled(mobileAdmin, "chatUnsubscribe", { businessId: CARRIER });

    expect(rooms(mobileAdmin.id)).not.toContain(chatStaffRoom(CARRIER));
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { socketClientEntry } from "./support/socket-client";

/**
 * The socket, and the permission that changed underneath it.
 *
 * `socket.data.isChatStaff` was decided ONCE, at the handshake, and a
 * company's chat is a ROOM — which is to say, the data channel itself. A user
 * who lost `delivery_manage` went on receiving every message in the company
 * for the rest of the connection: the body, the driver and the signed URL of
 * the attachment. HTTP refused from the next request onwards; the socket,
 * never.
 *
 * The fix is NOT to drop the connection. `permissions_changed` is about
 * authorisation, not authentication, and a server-side disconnect does not
 * reconnect on its own in socket.io-client — it would leave the whole company
 * without realtime until the next page load. The right move is to remove from
 * the room whoever no longer belongs in it, and that is what this file proves,
 * through the real channel.
 */
const prisma = new PrismaClient();

const CARRIER = "018fd000-0000-7000-8000-00000000000a";
const STAFF = "018fd000-0000-7000-8000-0000000000a1";

let server: Server;
let port = 0;

let token: string;
let profileAccessId = "";

let io: typeof import("@/websocket");
let client: {
  on: Function;
  removeAllListeners: Function;
  disconnect: () => void;
  emit: Function;
};

/**
 * The client lives in the web repository: the API is a server and has none.
 *
 * A test-only dependency in the production package is a dependency somebody
 * eventually imports in production.
 */
async function connectClient(): Promise<typeof client> {
  const entry = socketClientEntry();

  const { io: connect } = await import(/* @vite-ignore */ entry);

  return new Promise((resolve, reject) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(() => reject(new Error("timeout")), 10_000);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Waits for a chat message, or gives up. */
function waitForChat(timeoutMs = 2500): Promise<unknown | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);

    client.on("chatMessage", (message: unknown) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

/**
 * Waits until the socket really has stopped receiving, rather than for a
 * number of milliseconds somebody guessed.
 *
 * The re-evaluation reads the database once per connected socket, and how
 * long that takes depends on what else is running: this file was written with
 * a flat 1.5-second sleep and passed alone for weeks, then failed the first
 * time the whole E2E directory ran in parallel against one Postgres.
 *
 * A fixed sleep is the wrong shape for the question anyway. What the test
 * wants to know is "has the room been left yet", and the only way to observe
 * that from outside is to send something and see whether it arrives — so it
 * asks repeatedly, with a short window each time, until the answer changes or
 * the budget runs out. A socket that is still listening after the whole
 * budget is a real failure and still reported as one.
 */
async function waitUntilSilent(budgetMs = 15_000): Promise<unknown | null> {
  const deadline = Date.now() + budgetMs;

  let last: unknown | null = null;

  while (Date.now() < deadline) {
    client.removeAllListeners("chatMessage");

    const received = waitForChat(700);

    io.sendChatMessageEvent(CARRIER, null, anyMessage() as never);

    last = await received;

    if (last === null) return null;
  }

  return last;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Socket",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "99222888000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `socket-${randomUUID()}@exemplo.com.br`,
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
            canWrite: false,

            // `businessId` on the permission as well: the unique key is
            // (action, profileAccessId, businessId).
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  profileAccessId = profile.id;

  await prisma.user.create({
    data: {
      id: STAFF,
      name: "Atendente",
      email: `atendente-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: profile.id,
    },
  });

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: STAFF,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    {
      tokenType: "access",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: STAFF, expiresIn: "1h" },
  );

  server = createServer();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  port = (server.address() as AddressInfo).port;

  io = await import("@/websocket");
  await io.initializeSocketIO(server);

  client = await connectClient();

  // The server's connection handler is asynchronous — it reads the user, the
  // driver and the refresh family before joining any room. Measuring before
  // that would measure the race, not the rule.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}, 120_000);

afterAll(async () => {
  client?.disconnect();

  await io?.shutdownSocketIO();

  await new Promise<void>((resolve) => server.close(() => resolve()));

  await prisma.refreshToken.deleteMany({ where: { userId: STAFF } });
  await prisma.user.deleteMany({ where: { id: STAFF } });

  await prisma.permission.deleteMany({ where: { profileAccessId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileAccessId } });

  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

const anyMessage = () => ({
  id: randomUUID(),
  threadId: randomUUID(),
  body: "segredo da operação",
  kind: "TEXT",
});

describe("while the permission holds", () => {
  it("the staff member receives the company chat", async () => {
    const received = waitForChat();

    io.sendChatMessageEvent(CARRIER, null, anyMessage() as never);

    expect(await received).not.toBeNull();
  });
});

describe("once the permission is revoked", () => {
  it("the staff member stops receiving, without losing the connection", async () => {
    // A revogação como o produto a faz: a permissão muda no banco e o evento
    // de segurança sai.
    await prisma.permission.updateMany({
      where: { profileAccessId, permissionKey: "delivery_manage" },
      data: { canRead: false, canWrite: false },
    });

    io.sendSecurityEventToBusiness(CARRIER, { reason: "permissions_changed" });

    // The whole point: HTTP already refused from the next request onwards,
    // and the socket went on delivering the message body for the rest of the
    // connection.
    expect(await waitUntilSilent()).toBeNull();
  });

  it("and the connection is still up", async () => {
    // Dropping it would be worse: a server-side disconnect does not reconnect
    // on its own, and the company would be left without realtime until the
    // next page load.
    const online = await io.getOnlineUserIds([STAFF]);

    expect(online).toContain(STAFF);
  });
});

describe("when the re-evaluation cannot read the database", () => {
  it("removes from the room anyway", { timeout: 30_000 }, async () => {
    /**
     * The branch that only exists for the bad day.
     *
     * A read error must not be the reason somebody keeps listening to what
     * they should not. When in doubt, leave the room — getting back in costs
     * one `chatSubscribe`, and the client does exactly that when it redraws
     * the screen.
     */
    // The permission is restored BEFORE connecting; otherwise the second
    // client joins already without staff rights and the test would pass
    // without ever having been in the room — which is exactly what happened
    // in the first version of this test.
    await prisma.permission.updateMany({
      where: { profileAccessId, permissionKey: "delivery_manage" },
      data: { canRead: true },
    });

    const second = await connectClient();

    await new Promise((resolve) => setTimeout(resolve, 1200));

    // And proven: it IS in the room before anything else happens.
    const before = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500);

      second.on("chatMessage", (message: unknown) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

    io.sendChatMessageEvent(CARRIER, null, anyMessage() as never);

    expect(await before, "o segundo cliente não entrou na sala").not.toBeNull();

    second.removeAllListeners("chatMessage");

    const { UserRepository } = await import(
      "@/modules/user/repositories/user-repository"
    );

    const original = UserRepository.prototype.findUserById;

    UserRepository.prototype.findUserById = async () => {
      throw new Error("Can't reach database server");
    };

    try {
      io.sendSecurityEventToBusiness(CARRIER, { reason: "permissions_changed" });

      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      UserRepository.prototype.findUserById = original;
    }

    const received = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500);

      second.on("chatMessage", (message: unknown) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

    io.sendChatMessageEvent(CARRIER, null, anyMessage() as never);

    expect(await received).toBeNull();

    second.disconnect();
  });
});

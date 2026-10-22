import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";
import { socketTicketKey } from "@/shared/socket/socket-ticket";

import { APP_BOOT_TIMEOUT_MS } from "../support/app-boot";
import { socketClientEntry } from "./support/socket-client";

/**
 * POST /user/socket-ticket and its redemption at the Socket.IO handshake.
 *
 * The web used to hand the access token to page JavaScript for the socket.
 * Now its server mints a ticket and only the ticket reaches the page, so the
 * ticket must be worth exactly one connection of the session that minted it:
 * never twice, never late, never after that session ended or moved company.
 * Real HTTP route, real Redis, real handshake, real Postgres.
 */
const prisma = new PrismaClient();

const CARRIER_A = randomUUID();
const CARRIER_B = randomUUID();

let app: Awaited<typeof import("@/http")>["app"];
let io: typeof import("@/websocket");
let server: Server;
let port = 0;
let redis: Redis;

type ClientSocket = {
  on: Function;
  once: Function;
  off: Function;
  disconnect: () => void;
};

let connect: (url: string, options: unknown) => ClientSocket;

let next = 1;
const address = () => `10.92.${Math.floor(next / 250)}.${(next++ % 250) + 1}`;

async function seedBusiness(id: string, cnpj: string) {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${cnpj}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `ticket-${randomUUID()}@exemplo.com.br`,
    },
  });
}

/** A user with one live session; returns its access token. */
async function seedSession(
  businessId: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER" = "BUSINESS_ADMIN",
): Promise<{ userId: string; token: string; familyId: string }> {
  const userId = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: userId,
      name: "Pessoa Painel",
      email: `ticket-${userId}@exemplo.com.br`,
      password: "nao-usado",
      role,
      businessId,
      email_verified: new Date(),
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const token = sign(
    {
      tokenType: "access",
      role,
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );

  return { userId, token, familyId };
}

function mint(token: string | null) {
  return app.inject({
    method: "POST",
    url: "/user/socket-ticket",
    remoteAddress: address(),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function mintTicket(token: string): Promise<string> {
  const response = await mint(token);

  expect(response.statusCode, response.body).toBe(201);

  return response.json().ticket;
}

function open(
  auth: Record<string, string>,
): Promise<{ connected: boolean; code?: string; socket?: ClientSocket }> {
  return new Promise((done) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth,
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      done({ connected: false });
    }, 10_000);

    socket.on("connect", () => {
      clearTimeout(timer);
      done({ connected: true, socket });
    });

    socket.on(
      "connect_error",
      (error: Error & { data?: { code?: string } }) => {
        clearTimeout(timer);
        socket.disconnect();
        done({ connected: false, code: error.data?.code });
      },
    );
  });
}

async function handshake(auth: Record<string, string>) {
  const outcome = await open(auth);

  outcome.socket?.disconnect();

  return { connected: outcome.connected, code: outcome.code };
}

beforeAll(async () => {
  await seedBusiness(CARRIER_A, "71222333000101");
  await seedBusiness(CARRIER_B, "71222333000292");

  ({ app } = await import("@/http"));
  await app.ready();

  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;

  io = await import("@/websocket");
  await io.initializeSocketIO(server);

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));

  redis = new Redis(process.env.REDIS_URL as string);
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  io?.closeRealtimeConnections();
  await io?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));
  await app?.close();
  await redis?.quit();

  const businesses = [CARRIER_A, CARRIER_B];
  const users = await prisma.user.findMany({
    where: { businessId: { in: businesses } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.profileAccess.deleteMany({
    where: { businessId: { in: businesses } },
  });
  await prisma.business.deleteMany({ where: { id: { in: businesses } } });
  await prisma.$disconnect();
}, 60_000);

describe("POST /user/socket-ticket", () => {
  it("refuses a request without a session", async () => {
    const response = await mint(null);

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_TOKEN_MISSING");
  });

  it("refuses a refresh-type token as the bearer", async () => {
    const { userId, familyId } = await seedSession(CARRIER_A);
    const refreshLike = sign(
      { tokenType: "refresh", sessionVersion: 0, familyId },
      auth.secret_token,
      { subject: userId, expiresIn: "1h" },
    );

    expect((await mint(refreshLike)).statusCode).toBe(401);
  });

  it("issues a short-lived ticket, stored only as a hash, with no-store", async () => {
    const { token } = await seedSession(CARRIER_A);
    const response = await mint(token);

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");

    const { ticket, expiresIn } = response.json();

    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresIn).toBe(30);

    expect(await redis.exists(`socket-ticket:${ticket}`)).toBe(0);

    const ttl = await redis.ttl(socketTicketKey(ticket));

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it("needs no permission: an employee with the smallest profile gets one", async () => {
    const { userId, token } = await seedSession(CARRIER_A, "BUSINESS_USER");
    const profile = await prisma.profileAccess.create({
      data: {
        name: `Leitura ${userId}`,
        businessId: CARRIER_A,
        permissions: {
          create: {
            action: "Ler entregas",
            permissionKey: "delivery_management",
            canRead: true,
            businessId: CARRIER_A,
          },
        },
      },
    });

    await prisma.user.update({
      where: { id: userId },
      data: { profileAccessId: profile.id },
    });

    expect((await mint(token)).statusCode).toBe(201);
  });

  it("answers 429 past its per-user budget", async () => {
    const { token } = await seedSession(CARRIER_A);
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 31; attempt++) {
      statuses.push((await mint(token)).statusCode);
    }

    expect(statuses.slice(0, 30).every((status) => status === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("redeeming a ticket at the handshake", () => {
  it("connects once with a fresh ticket", async () => {
    const { token } = await seedSession(CARRIER_A);
    const ticket = await mintTicket(token);

    expect(await handshake({ ticket })).toEqual({
      connected: true,
      code: undefined,
    });
  });

  it("refuses the same ticket a second time (replay)", async () => {
    const { token } = await seedSession(CARRIER_A);
    const ticket = await mintTicket(token);

    expect((await handshake({ ticket })).connected).toBe(true);
    expect(await handshake({ ticket })).toEqual({
      connected: false,
      code: "SOCKET_TICKET_INVALID",
    });
  });

  it("refuses two racing handshakes beyond the first", async () => {
    const { token } = await seedSession(CARRIER_A);
    const ticket = await mintTicket(token);

    const outcomes = await Promise.all([
      handshake({ ticket }),
      handshake({ ticket }),
      handshake({ ticket }),
    ]);

    expect(outcomes.filter((outcome) => outcome.connected)).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.code === "SOCKET_TICKET_INVALID"),
    ).toHaveLength(2);
  });

  it("refuses an expired ticket", async () => {
    const { token } = await seedSession(CARRIER_A);
    const ticket = await mintTicket(token);

    // Same as waiting out the 30 s, without the wait.
    await redis.pexpire(socketTicketKey(ticket), 1);
    await new Promise((done) => setTimeout(done, 20));

    expect(await handshake({ ticket })).toEqual({
      connected: false,
      code: "SOCKET_TICKET_INVALID",
    });
  });

  it("refuses an invented or malformed ticket", async () => {
    expect((await handshake({ ticket: "a".repeat(43) })).code).toBe(
      "SOCKET_TICKET_INVALID",
    );
    expect((await handshake({ ticket: "../../etc" })).code).toBe(
      "SOCKET_TICKET_INVALID",
    );
  });

  it("refuses a ticket whose session logged out after minting", async () => {
    const { token } = await seedSession(CARRIER_A);
    const ticket = await mintTicket(token);

    const logout = await app.inject({
      method: "POST",
      url: "/user/logout",
      remoteAddress: address(),
      headers: { authorization: `Bearer ${token}` },
    });

    expect(logout.statusCode).toBe(200);

    expect(await handshake({ ticket })).toEqual({
      connected: false,
      code: "AUTH_SESSION_INVALIDATED",
    });
  });

  it("refuses a ticket after the session version moved (password change, revocation)", async () => {
    const { userId, token } = await seedSession(CARRIER_A);
    const ticket = await mintTicket(token);

    await prisma.user.update({
      where: { id: userId },
      data: { session_version: { increment: 1 } },
    });

    expect(await handshake({ ticket })).toEqual({
      connected: false,
      code: "AUTH_SESSION_INVALIDATED",
    });
  });

  it("refuses a ticket minted under another company than the user's now", async () => {
    const { userId, token } = await seedSession(CARRIER_A);
    const ticket = await mintTicket(token);

    await prisma.user.update({
      where: { id: userId },
      data: { businessId: CARRIER_B },
    });

    expect(await handshake({ ticket })).toEqual({
      connected: false,
      code: "AUTH_SESSION_INVALIDATED",
    });
  });

  it("joins only the minting company's rooms", async () => {
    const { token } = await seedSession(CARRIER_A);
    const ticket = await mintTicket(token);

    const outcome = await open({ ticket });

    expect(outcome.connected).toBe(true);

    const socket = outcome.socket as ClientSocket;
    const heard: string[] = [];

    socket.on("catalogChanged", (payload: { businessId: string }) => {
      heard.push(payload.businessId);
    });

    try {
      io.sendCatalogChangedEvent(CARRIER_B, "driver");
      io.sendCatalogChangedEvent(CARRIER_A, "driver");

      await vi.waitFor(() => expect(heard).toEqual([CARRIER_A]), {
        timeout: 5_000,
      });

      // Give a stray B frame the same chance to arrive.
      await new Promise((done) => setTimeout(done, 200));
      expect(heard).toEqual([CARRIER_A]);
    } finally {
      socket.disconnect();
    }
  });

  it("still accepts the app's bearer handshake", async () => {
    const { token } = await seedSession(CARRIER_A);

    expect((await handshake({ token })).connected).toBe(true);
  });
});

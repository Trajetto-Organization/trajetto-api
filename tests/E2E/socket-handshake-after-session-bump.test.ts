import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { APP_BOOT_TIMEOUT_MS } from "../support/app-boot";
import { socketClientEntry } from "./support/socket-client";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A socket handshake after the session moved on reads the CURRENT user.
 *
 * Booted the way server.ts boots it: Fastify listening on a real port and
 * Socket.IO attached to that same server, with real HTTP requests before the
 * handshake (app.inject would never reproduce it).
 *
 * The request context is entered with `enterWith`, so the store also stuck to
 * async resources created during the first request — connections opened
 * lazily — and the handshake ran through them. It found the first request's
 * store and the user row memoised there. Once the user's session_version moved
 * (a new login, a password change, a revocation), every later handshake
 * compared the fresh token with the old row and was refused with
 * AUTH_SESSION_INVALIDATED: on the web, "Não foi possível se conectar ao
 * serviço de notificações" on every page and no realtime at all.
 */
const prisma = createPrismaClient();

const CARRIER = randomUUID();

let app: Awaited<typeof import("@/http")>["app"];
let io: typeof import("@/websocket");
let base = "";

type ClientSocket = { on: Function; disconnect: () => void };

let connect: (url: string, options: unknown) => ClientSocket;

function accessToken(
  userId: string,
  familyId: string,
  sessionVersion: number,
): string {
  return sign(
    {
      tokenType: "access",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
      driverId: null,
      sessionVersion,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

/** "connected", or the refusal's code. */
function handshake(auth: Record<string, string>): Promise<string> {
  return new Promise((done) => {
    const socket = connect(base, {
      auth,
      transports: ["websocket"],
      reconnection: false,
    });

    socket.on("connect", () => {
      socket.disconnect();
      done("connected");
    });

    socket.on(
      "connect_error",
      (error: Error & { data?: { code?: string } }) => {
        done(error.data?.code ?? error.message);
      },
    );
  });
}

const me = (token: string) =>
  fetch(`${base}/user/me`, { headers: { authorization: `Bearer ${token}` } });

async function ticketFor(token: string): Promise<string> {
  const response = await fetch(`${base}/user/socket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.status).toBe(201);

  return ((await response.json()) as { ticket: string }).ticket;
}

/** A user with one live session at session_version 0. */
async function seedSession(): Promise<{ userId: string; familyId: string }> {
  const userId = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: userId,
      name: "Pessoa Painel",
      email: `bump-${userId}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
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

  return { userId, familyId };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Sessão",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "71222333000373",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `bump-${randomUUID()}@exemplo.com.br`,
    },
  });

  ({ app } = await import("@/http"));
  io = await import("@/websocket");

  await app.listen({ host: "127.0.0.1", port: 0 });
  await io.initializeSocketIO(app.server);

  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  io?.closeRealtimeConnections();
  await io?.shutdownSocketIO();
  await app?.close();

  const users = await prisma.user.findMany({
    where: { businessId: CARRIER },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });
  await prisma.$disconnect();
});

describe("socket handshake after a session_version bump", () => {
  it("accepts a ticket minted for the new session version", async () => {
    const { userId, familyId } = await seedSession();
    const before = accessToken(userId, familyId, 0);

    expect((await me(before)).status).toBe(200);
    expect(await handshake({ ticket: await ticketFor(before) })).toBe(
      "connected",
    );

    await prisma.user.update({
      where: { id: userId },
      data: { session_version: 1 },
    });
    const after = accessToken(userId, familyId, 1);

    expect((await me(after)).status).toBe(200);
    expect(await handshake({ ticket: await ticketFor(after) })).toBe(
      "connected",
    );
  });

  it("accepts a bearer token of the new session version", async () => {
    const { userId, familyId } = await seedSession();
    const before = accessToken(userId, familyId, 0);

    expect((await me(before)).status).toBe(200);
    expect(await handshake({ token: before })).toBe("connected");

    await prisma.user.update({
      where: { id: userId },
      data: { session_version: 1 },
    });
    const after = accessToken(userId, familyId, 1);

    expect((await me(after)).status).toBe(200);
    expect(await handshake({ token: after })).toBe("connected");
  });

  it("still refuses the token of the session that was bumped away", async () => {
    const { userId, familyId } = await seedSession();
    const before = accessToken(userId, familyId, 0);

    expect((await me(before)).status).toBe(200);
    expect(await handshake({ token: before })).toBe("connected");

    await prisma.user.update({
      where: { id: userId },
      data: { session_version: 1 },
    });

    expect(await handshake({ token: before })).toBe("AUTH_SESSION_INVALIDATED");
  });
});

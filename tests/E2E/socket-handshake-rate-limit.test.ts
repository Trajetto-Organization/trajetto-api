import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Redis from "ioredis";
import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { env } from "@/env";

import {
  HANDSHAKES_PER_USER,
  userHandshakeKey,
} from "@/shared/socket/handshake-rate-limit";

/**
 * The connection attempt, counted.
 *
 * Socket.IO answers `/socket.io/` before Fastify sees the request, so none of
 * the HTTP limiters ever applied to a handshake. The unit file next to this
 * one pins the counting rules; this one proves the wiring — that the server
 * really asks the limiter, with the key it says it uses, before it starts
 * querying the database.
 *
 * The counter is filled directly rather than by opening thirty-one sockets:
 * the property under test is "the server consults this bucket", and thirty
 * real connections would test socket.io's connection pool instead.
 */
const prisma = new PrismaClient();

const CARRIER = "018fd000-0000-7000-8000-0000000000c1";
const STAFF = "018fd000-0000-7000-8000-0000000000c2";

let server: Server;
let port = 0;
let token = "";
let profileAccessId = "";
let redis: Redis;

let io: typeof import("@/websocket");

/**
 * The client lives in the web repository: the API is a server and has none.
 *
 * A test-only dependency in the production package is a dependency somebody
 * eventually imports in production.
 */
async function connect(): Promise<{ disconnect: () => void }> {
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

  const { io: createClient } = await import(/* @vite-ignore */ entry);

  return new Promise((settle, reject) => {
    const socket = createClient(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(() => reject(new Error("timeout")), 10_000);

    socket.on("connect", () => {
      clearTimeout(timer);
      settle(socket);
    });

    socket.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Handshake",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "99222888000144",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `handshake-${randomUUID()}@exemplo.com.br`,
    },
  });

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Operação",
      businessId: CARRIER,

      // A BUSINESS_USER with neither permissions nor a driver record is
      // refused at the handshake by `assertSessionEligible`, long before the
      // limiter would have anything to say.
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Gerenciar entregas",
            canRead: true,
            canWrite: false,
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
      name: "Operador",
      email: `operador-${randomUUID()}@exemplo.com.br`,
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

  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));

  port = (server.address() as AddressInfo).port;

  io = await import("@/websocket");
  await io.initializeSocketIO(server);

  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });

  await new Promise<void>((settle, reject) => {
    redis.once("ready", settle);
    redis.once("error", reject);
  });
}, 120_000);

afterAll(async () => {
  await redis?.del(userHandshakeKey(STAFF));
  await redis?.quit();

  await io?.shutdownSocketIO();

  await new Promise<void>((settle) => server.close(() => settle()));

  await prisma.refreshToken.deleteMany({ where: { userId: STAFF } });
  await prisma.user.deleteMany({ where: { id: STAFF } });
  await prisma.permission.deleteMany({ where: { profileAccessId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileAccessId } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

describe("a handshake with room left", () => {
  it("connects, and leaves a count behind under the key it says it uses", async () => {
    await redis.del(userHandshakeKey(STAFF));

    const socket = await connect();

    socket.disconnect();

    /**
     * The key is part of the contract, not an implementation detail.
     *
     * If the server counted under some other key, every assertion below would
     * be filling a bucket nobody reads — the test would pass while the limiter
     * did nothing, which is the failure this whole file exists to rule out.
     */
    expect(await redis.get(userHandshakeKey(STAFF))).toBe("1");

    // And the bucket expires, rather than counting a user's connections for
    // the rest of the process's life.
    expect(await redis.ttl(userHandshakeKey(STAFF))).toBeGreaterThan(0);
  });
});

describe("a handshake past the budget", () => {
  it("is refused before the database is touched", async () => {
    await redis.set(
      userHandshakeKey(STAFF),
      String(HANDSHAKES_PER_USER + 5),
      "EX",
      60,
    );

    /**
     * The REASON matters, not merely that it failed.
     *
     * `rejects.toThrow()` alone would pass if the server were down, the token
     * were malformed or the profile were misconfigured — the handshake has
     * five other ways to refuse, and any of them would have made this green
     * while the limiter did nothing.
     */
    const refusal = await connect().then(
      () => null,
      (error: Error & { data?: { code?: string } }) => error,
    );

    expect(refusal).not.toBeNull();
    expect(refusal?.data?.code).toBe("SOCKET_RATE_LIMITED");
  });

  it("connects again once the bucket is cleared", async () => {
    await redis.del(userHandshakeKey(STAFF));

    const socket = await connect();

    expect(socket).toBeTruthy();

    socket.disconnect();
  });
});

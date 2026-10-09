import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import Redis from "ioredis";
import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { env } from "@/env";

import {
  SOCKET_MAX_CONNECTIONS_PER_USER,
  userHandshakeKey,
} from "@/shared/socket/handshake-rate-limit";

import { socketClientEntry } from "./support/socket-client";

/**
 * How many sockets one user may hold open on a replica.
 *
 * The handshake limiter counts ATTEMPTS per minute, not connections that
 * stay: one valid token opening thirty sockets a minute and keeping them had
 * no ceiling — tens of thousands in a day, each in the user's rooms, each a
 * copy of every emit to them. A dispatcher's tabs are a handful; twenty per
 * replica is room to spare.
 */
const prisma = new PrismaClient();

const CARRIER = "018fd000-0000-7000-8000-0000000cab01";
const STAFF = "018fd000-0000-7000-8000-0000000cab11";

interface TestSocket {
  on: (event: string, handler: (...args: any[]) => void) => void;
  disconnect: () => void;
}

let server: Server;
let port = 0;
let token = "";
let profileId = "";
let redis: Redis;

let io: typeof import("@/websocket");
let connect: (url: string, options: unknown) => TestSocket;

const open: TestSocket[] = [];

function connectOnce(): Promise<TestSocket> {
  return new Promise((done, reject) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
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

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Teto",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "99222888000166",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `teto-${randomUUID()}@exemplo.com.br`,
    },
  });

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Operação",
      businessId: CARRIER,
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

  profileId = profile.id;

  await prisma.user.create({
    data: {
      id: STAFF,
      name: "Despachante das Abas",
      email: `abas-${randomUUID()}@exemplo.com.br`,
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
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;

  io = await import("@/websocket");
  await io.initializeSocketIO(server);

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));

  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });

  // The attempt budget is not what this file measures.
  await redis.del(userHandshakeKey(STAFF));
}, 120_000);

afterAll(async () => {
  for (const socket of open) socket.disconnect();

  await redis?.del(userHandshakeKey(STAFF));
  await redis?.quit();

  await io?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));

  await prisma.refreshToken.deleteMany({ where: { userId: STAFF } });
  await prisma.user.deleteMany({ where: { id: STAFF } });
  await prisma.permission.deleteMany({ where: { profileAccessId: profileId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileId } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

describe("sockets held open by one user", () => {
  it("are refused past the ceiling, with a code of their own", async () => {
    for (let tab = 0; tab < SOCKET_MAX_CONNECTIONS_PER_USER; tab += 1) {
      open.push(await connectOnce());
    }

    const refusal = await connectOnce().then(
      (socket) => {
        open.push(socket);
        return null;
      },
      (error: Error & { data?: { code?: string } }) => error,
    );

    expect(refusal, "the socket past the ceiling connected").not.toBeNull();
    expect(refusal?.data?.code).toBe("SOCKET_TOO_MANY_CONNECTIONS");
  }, 60_000);

  it("make room again when one of them closes", async () => {
    open.shift()?.disconnect();

    // The server sees the close a moment after the client does.
    await new Promise((done) => setTimeout(done, 500));

    open.push(await connectOnce());
  }, 30_000);
});

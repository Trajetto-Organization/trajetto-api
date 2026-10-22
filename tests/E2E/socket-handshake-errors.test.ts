import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { socketClientEntry } from "./support/socket-client";

/**
 * What a refused handshake says about WHY.
 *
 * Every failure that was not an AppError came back as AUTH_TOKEN_INVALID —
 * including the database being unreachable. The clients believe that code:
 * the web reloads the page to renew the token, the app refreshes it. So a
 * Postgres blink sent the whole fleet to renew perfectly good credentials, all
 * at once, against a database that was already struggling.
 */
const prisma = new PrismaClient();

const CARRIER = "018fdb00-0000-7000-8000-00000000000a";
const USER = "018fdb00-0000-7000-8000-0000000000a1";

let server: Server;
let port = 0;
let io: typeof import("@/websocket");

let connect: (
  url: string,
  options: unknown,
) => {
  on: Function;
  disconnect: () => void;
};

let token = "";

function handshake(
  withToken: string,
): Promise<{ connected: boolean; code?: string }> {
  return new Promise((done) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token: withToken },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(() => done({ connected: false }), 10_000);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.disconnect();
      done({ connected: true });
    });

    socket.on(
      "connect_error",
      (error: Error & { data?: { code?: string } }) => {
        clearTimeout(timer);
        done({ connected: false, code: error.data?.code });
      },
    );
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
      cnpj: "66777888000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `handshake-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa Painel",
      email: `painel-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: USER,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    {
      tokenType: "access",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: USER, expiresIn: "1h" },
  );

  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;

  io = await import("@/websocket");
  await io.initializeSocketIO(server);

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));
}, 120_000);

afterAll(async () => {
  io?.closeRealtimeConnections();
  await io?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));

  await prisma.refreshToken.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });
  await prisma.$disconnect();
}, 60_000);

describe("a handshake the database could not answer", () => {
  it("is refused as unavailable, not as a bad token", async () => {
    const { UserRepository } = await import(
      "@/modules/user/repositories/user-repository"
    );

    const original = UserRepository.prototype.findUserById;

    UserRepository.prototype.findUserById = async () => {
      throw new Error("Can't reach database server");
    };

    try {
      const outcome = await handshake(token);

      expect(outcome.connected).toBe(false);
      expect(outcome.code).toBe("SOCKET_UNAVAILABLE");
    } finally {
      UserRepository.prototype.findUserById = original;
    }
  });
});

describe("a handshake with a token that is actually bad", () => {
  it("is still refused as a bad token", async () => {
    const forged = sign({ tokenType: "access" }, "not-the-secret", {
      subject: USER,
    });

    expect(await handshake(forged)).toEqual({
      connected: false,
      code: "AUTH_TOKEN_INVALID",
    });
  });

  it("and a good one still connects", async () => {
    expect((await handshake(token)).connected).toBe(true);
  });
});

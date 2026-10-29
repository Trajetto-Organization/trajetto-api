import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import pino from "pino";

import { issueSessionTokenPair } from "@/modules/user/services/session-service";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * OBS-12: failures on the client side never reached us. The app's logger only
 * wrote to the phone's console; a photo whose PUT to the bucket was refused
 * kept its item pending forever, in silence; a browser upload that failed told
 * only the person looking at the screen. The operation learned about a broken
 * bucket credential when a customer asked for a proof that never arrived.
 *
 * POST /diagnostics/client is where a client reports that — counts and the
 * last errors by kind, never content — and the report becomes one structured
 * warn line (`client.diagnostics`) the log search and the alerting can read.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let written = "";

const BUSINESS = "018fc000-0000-7000-8000-000000000fd1";
const USER = "018fc000-0000-7000-8000-000000000fd2";

let token = "";
let next = 1;
const address = () => `10.81.${Math.floor(next / 250)}.${(next++ % 250) + 1}`;

const lines = () =>
  written
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

function report(payload: unknown, bearer: string | null = token) {
  return app.inject({
    method: "POST",
    url: "/diagnostics/client",
    remoteAddress: address(),
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: payload as Record<string, unknown>,
  });
}

const degraded = {
  platform: "android",
  appVersion: "1.8.0",
  outbox: { pending: 3, failed: 0, stuck: 2, oldestAgeSec: 5_400 },
  errors: [
    {
      kind: "upload",
      event: "outbox_item_failed",
      status: 403,
      host: "trajetto.r2.cloudflarestorage.com",
      message: "Falha no envio do arquivo (HTTP 403)",
      count: 7,
    },
  ],
};

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Diagnóstico",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000712",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `diag-${randomUUID()}@exemplo.com.br`,
    },
  });

  const user = await prisma.user.create({
    data: {
      id: USER,
      name: "Motorista do Diagnóstico",
      email: `diag-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  const pair = issueSessionTokenPair(user as never);

  await prisma.refreshToken.create({
    data: {
      userId: USER,
      token_hash: pair.refreshTokenHash,
      jti: pair.refreshJti,
      family_id: pair.familyId,
      expires_in: pair.expiresAt,
    },
  });

  token = pair.token;

  ({ app } = await import("@/http"));
  await app.ready();

  (app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = {
    write(chunk: string) {
      written += chunk;
    },
  };
}, 120_000);

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a client reporting what failed on its side", () => {
  it("is accepted and written as one structured line, with who sent it", async () => {
    const response = await report(degraded);

    expect(response.statusCode, response.body).toBe(202);

    const line = lines().find((entry) => entry.event === "client.diagnostics");

    expect(line).toMatchObject({
      level: 40,
      event: "client.diagnostics",
      userId: USER,
      businessId: BUSINESS,
      platform: "android",
      appVersion: "1.8.0",
      outbox: degraded.outbox,
      errors: degraded.errors,
    });
  });

  it("needs a session", async () => {
    expect((await report(degraded, null)).statusCode).toBe(401);
  });

  it("refuses a report bigger than a summary", async () => {
    const errors = Array.from({ length: 11 }, () => degraded.errors[0]);

    expect((await report({ ...degraded, errors })).statusCode).toBe(400);
    expect(
      (
        await report({
          ...degraded,
          errors: [{ ...degraded.errors[0], message: "x".repeat(1_000) }],
        })
      ).statusCode,
    ).toBe(400);
  });

  it("accepts the minimal report an older build could send", async () => {
    const response = await report({ platform: "web", errors: [] });

    expect(response.statusCode, response.body).toBe(202);
  });
});

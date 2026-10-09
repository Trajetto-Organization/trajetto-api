import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { APP_BOOT_TIMEOUT_MS } from "../support/app-boot";
import { seedSweepCarrier, sweepToken, type CarrierIds } from "./support/idor-sweep-seed";

/**
 * Hostile input on the real stack: what reaches PostgreSQL, what the parser
 * refuses, and how long it takes to say so.
 *
 * Found in the 10/2026 security pass: a U+0000 or a lone surrogate in any
 * text — a shipper's name, a ticket's subject, the `search` of every list —
 * passed validation and crashed the query engine, a 500 logged at error
 * level. Anyone with a session could fill the alerts with "broken release"
 * noise, one request at a time.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let A: CarrierIds;
let token = "";

async function send(method: "GET" | "POST", url: string, payload?: string, auth = true) {
  const started = Date.now();

  const response = await app.inject({
    method,
    url,
    headers: {
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      "idempotency-key": randomUUID(),
    },
    payload,
  });

  return { response, elapsed: Date.now() - started };
}

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();

  A = await seedSweepCarrier(prisma, { label: "Entrada", marker: "ZZENTRADA" });
  token = await sweepToken(prisma, A.businessId, "BUSINESS_ADMIN");
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("text PostgreSQL cannot store", () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["shipper name with NUL", "/shipper/create-shipper/{b}", { name: "Emb\u0000arcador" }],
    ["shipper name with a lone surrogate", "/shipper/create-shipper/{b}", { name: "Emb\ud800arcador" }],
    ["status reason with NUL", "/status-change-reason/create-status-change-reason/{b}", { name: "Mo\u0000tivo" }],
    [
      "occurrence type with NUL",
      "/occurrence-type/create-occurrence-type/{b}",
      { name: "Ti\u0000po", category: "NOT_DELIVERED" },
    ],
  ];

  for (const [label, path, body] of cases) {
    it(`refuses a ${label} with 400, not 500, and stores nothing`, async () => {
      const before = await prisma.shipper.count({ where: { businessId: A.businessId } });

      const { response } = await send(
        "POST",
        path.replace("{b}", A.businessId),
        JSON.stringify(body),
      );

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "O texto enviado contém um caractere inválido.",
      });
      expect(await prisma.shipper.count({ where: { businessId: A.businessId } })).toBe(before);
    });
  }

  it("refuses it in a support ticket's subject and first message", async () => {
    const { response } = await send(
      "POST",
      "/chat/tickets",
      JSON.stringify({
        businessId: A.businessId,
        driverId: A.driverId,
        subject: "As\u0000sunto",
        message: { kind: "TEXT", body: "o\u0000i" },
      }),
    );

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });

  it("refuses it in the search of a list (%00 in the query string)", async () => {
    for (const list of ["/shipper/list-shipper", "/delivery/list-delivery"]) {
      const { response } = await send(
        "GET",
        `${list}?businessId=${A.businessId}&page=1&pageSize=10&search=a%00b`,
      );

      expect(response.statusCode, `${list}: ${response.body}`).toBe(400);
      expect(response.json().code).toBe("VALIDATION_ERROR");
    }
  });

  it("refuses it on an anonymous route as well", async () => {
    const { response } = await send(
      "POST",
      "/user/forgot/password",
      JSON.stringify({ email: "a\u0000b@exemplo.com.br" }),
      false,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });

  it("still accepts accents, emoji and line breaks", async () => {
    const { response } = await send(
      "POST",
      `/shipper/create-shipper/${A.businessId}`,
      JSON.stringify({ name: `Ação Logística 😀 ${randomUUID().slice(0, 6)}` }),
    );

    expect(response.statusCode, response.body).toBe(201);
  });
});

describe("the JSON parser", () => {
  it("refuses __proto__ and constructor.prototype keys (prototype poisoning)", async () => {
    for (const payload of [
      `{"name":"Proto Um","__proto__":{"isAdmin":true}}`,
      `{"name":"Proto Dois","constructor":{"prototype":{"isAdmin":true}}}`,
    ]) {
      const { response } = await send("POST", `/shipper/create-shipper/${A.businessId}`, payload);

      expect(response.statusCode, payload).toBe(400);
      expect(response.json().code).toBe("MALFORMED_REQUEST");
    }

    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("refuses a body over the 1 MB limit with 413 before reading the database", async () => {
    const { response } = await send(
      "POST",
      `/shipper/create-shipper/${A.businessId}`,
      JSON.stringify({ name: "x".repeat(2_000_000) }),
    );

    expect(response.statusCode).toBe(413);
  });

  it("answers a body nested 200 000 deep quickly, without freezing the process", async () => {
    const deep = "[".repeat(200_000) + '"a"' + "]".repeat(200_000);

    const { response, elapsed } = await send(
      "POST",
      "/user/session",
      `{"email":"ninguem@exemplo.com.br","password":"senha-qualquer","a":${deep}}`,
      false,
    );

    expect(response.statusCode).toBeLessThan(500);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("headers on every answer", () => {
  it("carries the security headers and grants no CORS to a foreign origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/user/me",
      headers: { authorization: `Bearer ${token}`, origin: "https://atacante.example" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(response.headers["x-frame-options"]).toBeDefined();
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

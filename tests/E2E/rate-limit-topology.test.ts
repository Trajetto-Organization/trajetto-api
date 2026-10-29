import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomInt, randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The anonymous limits, in the topology production actually has.
 *
 * Login, two-factor, password recovery and refresh reach the API from the
 * Next.js server — a server action or the middleware makes the call, not the
 * browser. Every web user therefore arrived from one address, and the
 * per-address limits were limits for the whole product: eight logins a minute
 * for every carrier together, and a refresh budget that ordinary traffic used
 * up, logging people out with no attacker in sight.
 *
 * Each request below comes from the SAME socket address, the web server's.
 */
const FORWARDER_SECRET = vi.hoisted(() => {
  const secret = "s".repeat(48);
  process.env.RATE_LIMIT_FORWARDER_SECRET = secret;

  // What production runs behind Traefik, and what the boot now demands there.
  process.env.RATE_LIMIT_TRUSTED_PROXY = "xff";
  return secret;
});

const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let issueSessionTokenPair: typeof import("@/modules/user/services/session-service").issueSessionTokenPair;

const BUSINESS = "018fc000-0000-7000-8000-0000000003b1";

/** Fresh addresses per run: the counters live in Redis across runs. */
const octet = () => randomInt(1, 250);
const WEB_SERVER = `10.${octet()}.${octet()}.${octet()}`;
const browser = () => `189.${octet()}.${octet()}.${octet()}`;

const userIds: string[] = [];

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora Topologia",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "33444555000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `topologia-${randomUUID()}@exemplo.com.br`,
    },
  });

  ({ issueSessionTokenPair } = await import(
    "@/modules/user/services/session-service"
  ));

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

async function signedInUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Pessoa Web",
      email: `web-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  userIds.push(user.id);

  const pair = issueSessionTokenPair(user as never);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token_hash: pair.refreshTokenHash,
      jti: pair.refreshJti,
      family_id: pair.familyId,
      expires_in: pair.expiresAt,
    },
  });

  return pair.refresh_token;
}

const login = (headers: Record<string, string>) =>
  app.inject({
    method: "POST",
    url: "/user/session",
    remoteAddress: WEB_SERVER,
    headers,
    payload: {
      email: `ninguem-${randomUUID()}@exemplo.com.br`,
      password: "senha-errada-123",
    },
  });

describe("refresh through the web server", () => {
  it("serves eleven different people renewing in the same minute", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 11 }, () => signedInUser()),
    );

    const statuses: number[] = [];

    for (const token of tokens) {
      const response = await app.inject({
        method: "POST",
        url: "/user/refresh-token",
        remoteAddress: WEB_SERVER,
        payload: { token },
      });

      statuses.push(response.statusCode);
    }

    // Before: the eleventh person got 429, and the web middleware turned it
    // into a logout.
    expect(statuses).toEqual(Array(11).fill(200));
  });
});

describe("login through the web server", () => {
  it("counts each browser on its own when the web server vouches for it", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await login({
        "x-trajetto-client-ip": browser(),
        "x-trajetto-forwarder-secret": FORWARDER_SECRET,
      });

      statuses.push(response.statusCode);
    }

    // Twelve people failing a password each: nobody is throttled.
    expect(statuses).not.toContain(429);
  });

  it("still throttles one browser hammering the login", async () => {
    const attacker = browser();
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await login({
        "x-trajetto-client-ip": attacker,
        "x-trajetto-forwarder-secret": FORWARDER_SECRET,
      });

      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 8)).not.toContain(429);
    expect(statuses.slice(8)).toEqual([429, 429]);
  });

  it("ignores a forwarded address that comes without the right secret", async () => {
    // An attacker writing the header themselves, with a new "browser"
    // address per attempt and a guessed secret, all from one socket. Were the
    // header honoured, each attempt would open a fresh bucket.
    const sameSocket = `172.${octet()}.${octet()}.${octet()}`;
    const forged: number[] = [];

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/user/session",
        remoteAddress: sameSocket,
        headers: {
          "x-trajetto-client-ip": browser(),
          "x-trajetto-forwarder-secret": "adivinhado".repeat(5),
        },
        payload: { email: "alvo@exemplo.com.br", password: "chute-1234" },
      });

      forged.push(response.statusCode);
    }

    expect(forged.slice(8)).toEqual([429, 429]);
  });
});

describe("the load balancer's probe, while someone floods the public health endpoint", () => {
  /**
   * OBS-01. The probes have no limit of their own, so they count in the
   * global per-address bucket — and with `none`, every proxied request and
   * Traefik's own probe were the same address. Three hundred anonymous GETs a
   * minute to /health drained it; the readiness probe got 429 on both
   * replicas and Traefik took them out of rotation: the whole API down, from
   * one machine. Under `xff` the flood counts against the address Traefik
   * saw, and the probe — which Traefik sends itself, with no X-Forwarded-For —
   * keeps a bucket nobody else can reach.
   */
  /**
   * Until the limiter's Redis connection is ready it fails open, and a loop
   * of `inject` never yields to the event loop's I/O phase — so a flood sent
   * straight after boot is never counted at all, and would prove nothing.
   */
  async function limiterCounting(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const answer = await app.inject({
        method: "GET",
        url: "/health/liveness",
        remoteAddress: `10.${octet()}.${octet()}.${octet()}`,
      });

      if (answer.headers["x-ratelimit-reset"] !== "0") return;

      await new Promise((done) => setTimeout(done, 100));
    }

    throw new Error("o limitador nunca começou a contar");
  }

  it("keeps answering the readiness probe", async () => {
    const TRAEFIK = `10.${octet()}.${octet()}.${octet()}`;
    const attacker = browser();

    await limiterCounting();

    for (let index = 0; index < 301; index += 1) {
      await app.inject({
        method: "GET",
        url: "/health/liveness",
        remoteAddress: TRAEFIK,
        headers: { "x-forwarded-for": attacker },
      });
    }

    const flooded = await app.inject({
      method: "GET",
      url: "/health/liveness",
      remoteAddress: TRAEFIK,
      headers: { "x-forwarded-for": attacker },
    });

    // The flood itself IS limited — the point is who pays for it.
    expect(flooded.statusCode).toBe(429);

    const probe = await app.inject({
      method: "GET",
      url: "/health/readiness",
      remoteAddress: TRAEFIK,
    });

    expect(probe.statusCode).toBe(200);
  }, 120_000);
});

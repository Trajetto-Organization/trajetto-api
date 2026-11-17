import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomInt, randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Load shedding through the whole stack, with the replica pressed on
 * purpose (plano-escala F2-24).
 *
 * The pressure is the database pool's: its signal is forced, and the real
 * @fastify/under-pressure picks it up on its next health check, exactly as
 * it would a pool with more requests waiting than connections. The event
 * loop is read as calm, whatever the machine running the test is doing.
 *
 * What must hold:
 *  - observe (the default) answers exactly as without pressure;
 *  - enforce refuses a deferrable route (the tower) with 503 SERVICE_BUSY,
 *    Retry-After and the request id, BEFORE the session lookup;
 *  - enforce still serves what is interactive (the pool alone never refuses
 *    it), what is critical, and the GPS positions while their gate is shut
 *    (an empty window: they wait for the fleet's contract, F2-25), and
 *    refuses them with the app's 120 s once it is open;
 *  - with the loop drowning, an interactive route is refused too.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let env: (typeof import("@/env"))["env"];
let shedding: typeof import("@/shared/http/load-shedding");
let UserRepository: typeof import("@/modules/user/repositories/user-repository").UserRepository;

const BUSINESS = randomUUID();
const USER = randomUUID();

let token = "";

const octet = () => randomInt(1, 250);

const calm = {
  eventLoopDelay: 0,
  eventLoopUtilized: 0.1,
  heapUsed: 0,
  rssBytes: 0,
};

let loop = calm;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora Sob Pressão",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(71000000000000 + randomInt(1, 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pressao-${randomUUID()}@example.com`,
    },
  });

  const user = await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa do Painel",
      email: `painel-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  const { issueSessionTokenPair } =
    await import("@/modules/user/services/session-service");

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

  ({ env } = await import("@/env"));
  shedding = await import("@/shared/http/load-shedding");
  ({ UserRepository } =
    await import("@/modules/user/repositories/user-repository"));
  ({ app } = await import("@/http"));
  await app.ready();

  vi.spyOn(
    app as unknown as { memoryUsage: () => typeof calm },
    "memoryUsage",
  ).mockImplementation(() => loop);
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();

  await prisma.refreshToken.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

const call = (method: "GET" | "POST", url: string, authenticated = false) =>
  app.inject({
    method,
    url,
    // A new address each time: the limiter must not be what answers.
    remoteAddress: `10.${octet()}.${octet()}.${octet()}`,
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
  });

describe("a replica whose pool is saturated", () => {
  beforeAll(async () => {
    vi.spyOn(shedding.pressureSignals, "poolSaturated").mockReturnValue(true);

    // The plugin re-reads its health check every second.
    await vi.waitFor(
      async () => {
        const before = shedding.shedMetrics.snapshot().under_pressure;

        await call("GET", "/health/liveness");

        expect(shedding.shedMetrics.snapshot().under_pressure).toBeGreaterThan(
          before,
        );
      },
      { timeout: 10_000, interval: 200 },
    );
  }, 30_000);

  it("in observe, answers exactly as without pressure", async () => {
    expect(env.SHED_MODE).toBe("observe");

    const before = shedding.shedMetrics.snapshot().would_shed.tower ?? 0;

    expect((await call("GET", "/route/control-tower")).statusCode).toBe(401);
    expect((await call("GET", "/user/me", true)).statusCode).toBe(200);

    expect(shedding.shedMetrics.snapshot().would_shed.tower).toBe(before + 1);
  });

  describe("in enforce", () => {
    beforeAll(() => {
      env.SHED_MODE = "enforce";
    });

    afterAll(() => {
      env.SHED_MODE = "observe";
      loop = calm;
    });

    it("refuses the tower with 503 SERVICE_BUSY before the session lookup", async () => {
      const lookups = vi.spyOn(UserRepository.prototype, "findUserById");

      const refused = await call("GET", "/route/control-tower", true);

      expect(refused.statusCode).toBe(503);
      expect(refused.headers["retry-after"]).toBe("5");
      expect(refused.headers["x-request-id"]).toBeTruthy();
      expect(refused.json()).toMatchObject({
        code: "SERVICE_BUSY",
        message: "O sistema está ocupado; tente de novo em instantes.",
      });
      expect(lookups).not.toHaveBeenCalled();

      lookups.mockRestore();
    });

    it("still serves an interactive read, a probe and the positions", async () => {
      expect((await call("GET", "/user/me", true)).statusCode).toBe(200);
      expect((await call("GET", "/health/liveness")).statusCode).toBe(200);

      // Not refused for load: the answer is the session's, as always.
      expect((await call("POST", "/route/positions")).statusCode).toBe(401);
    });

    // With the positions' gate forced open (F2-25): the same refusal, with
    // the app's own wait, still before the session.
    it("refuses the positions with 120 s once their gate is open", async () => {
      const saved = env.SHED_POSITIONS_MODE;
      env.SHED_POSITIONS_MODE = "enforce";

      try {
        await vi.waitFor(
          async () => {
            const refused = await call("POST", "/route/positions");

            expect(refused.statusCode).toBe(503);
            expect(refused.headers["retry-after"]).toBe("120");
          },
          // The gate is read at most once a second.
          { timeout: 5_000, interval: 250 },
        );
      } finally {
        env.SHED_POSITIONS_MODE = saved;
      }
    });

    it("refuses an interactive read once the loop is drowning", async () => {
      loop = { ...calm, eventLoopUtilized: 0.99 };

      const refused = await call("GET", "/user/me", true);

      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({ code: "SERVICE_BUSY" });

      // Critical, whatever the pressure.
      expect((await call("GET", "/health/liveness")).statusCode).toBe(200);
    });
  });
});

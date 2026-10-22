import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * The API gets its database back without a restart.
 *
 * health-under-failure and auth-under-failure both end with "recovers on the
 * next call, with no restart" — and both simulate the outage by swapping a
 * method for one that throws, then put the method back before that case
 * runs. What those cases prove is that the patch was undone. A pool that
 * never reconnects after Postgres drops its connections would pass them.
 *
 * Here the connections really die: another session terminates every backend
 * this app holds, which is what a Postgres restart, a failover or a proxy
 * recycling its upstreams does to a running replica. Safe to do in the suite
 * because the test environment gives each file its own database — only this
 * file's connections live in it.
 */
const prisma = new PrismaClient();

/** A session of its own, so it survives the terminations it issues. */
const killer = new PrismaClient();

const CARRIER = "018fb000-0000-7000-8000-0000000003a1";
const USER = "018fb000-0000-7000-8000-0000000003b1";

let app: Awaited<typeof import("@/http")>["app"];
let token = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Reconexão",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "55333888000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `reconexao-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Gestora",
      email: `gestora-reconexao-${randomUUID()}@exemplo.com.br`,
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
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: USER, expiresIn: "1h" },
  );

  ({ app } = await import("@/http"));
  await app.ready();

  // The killer's own backend has to exist before it can exclude itself.
  await killer.$queryRaw`SELECT 1`;
}, 90_000);

afterAll(async () => {
  await app?.close();
  await killer.$disconnect();
  await prisma.$disconnect();
});

const health = () => app.inject({ method: "GET", url: "/health" });

const authenticated = () =>
  app.inject({
    method: "GET",
    url: "/notification/unread-count",
    headers: { authorization: `Bearer ${token}` },
  });

/** Every connection to this database except the killer's own. */
async function terminateEveryOtherBackend(): Promise<number> {
  const rows = await killer.$queryRaw<Array<{ terminated: boolean }>>`
    SELECT pg_terminate_backend(pid) AS terminated
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
  `;

  return rows.filter((row) => row.terminated).length;
}

/**
 * Calls until the answer is 200, collecting every status on the way. The
 * pool may hand out a dead connection or two before it notices; what it may
 * not do is keep failing.
 */
async function untilOk(
  call: () => Promise<{ statusCode: number }>,
  attempts = 25,
): Promise<number[]> {
  const statuses: number[] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { statusCode } = await call();
    statuses.push(statusCode);

    if (statusCode === 200) return statuses;

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return statuses;
}

describe("a database that dropped every connection the API held", () => {
  it("is healthy again on its own", { timeout: 30_000 }, async () => {
    // Warm the pool, so there is something to kill.
    expect((await health()).statusCode).toBe(200);
    expect((await authenticated()).statusCode).toBe(200);

    const terminated = await terminateEveryOtherBackend();

    // Nothing killed means nothing tested.
    expect(terminated).toBeGreaterThan(0);

    const statuses = await untilOk(health);

    expect(last(statuses), `respostas: ${statuses.join(", ")}`).toBe(200);
  });

  it(
    "serves an authenticated request again, and never answers 401 on the way",
    { timeout: 30_000 },
    async () => {
      expect((await authenticated()).statusCode).toBe(200);

      expect(await terminateEveryOtherBackend()).toBeGreaterThan(0);

      const statuses = await untilOk(authenticated);

      // A 401 is the one answer both clients read as "your session ended":
      // every driver logged out because Postgres restarted.
      expect(statuses, `respostas: ${statuses.join(", ")}`).not.toContain(401);
      expect(last(statuses), `respostas: ${statuses.join(", ")}`).toBe(200);
    },
  );
});

function last(statuses: number[]): number | undefined {
  return statuses[statuses.length - 1];
}

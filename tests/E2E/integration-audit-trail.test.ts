import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * The credentials of an integration, and whether anybody can tell who changed
 * them.
 *
 * Issuing an API key hands a system standing access to a company's deliveries.
 * Revoking one stops somebody's ERP mid-sentence. Pointing a webhook somewhere
 * sends every event of the operation to an address a person typed. Sixty-eight
 * actions across twenty modules were written to the activity feed and none of
 * these four were — so the decision an auditor would look for FIRST left no
 * trace at all.
 *
 * Asserted through the real path, which is the only honest way: the controller
 * publishes to the outbox, the pipeline turns it into an Activity row, and the
 * feed reads it. A test that called the service directly would prove the
 * service works and say nothing about whether the controller calls it.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdb00-0000-7000-8000-00000000000a";
const ADMIN = "018fdb00-0000-7000-8000-0000000000a1";

let token = "";

async function tokenFor(userId: string, businessId: string): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    {
      tokenType: "access",
      role: "BUSINESS_ADMIN",
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Auditoria",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(53000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `audit-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Administradora da Transportadora",
      email: `admin-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  token = await tokenFor(ADMIN, CARRIER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.activity.deleteMany({ where: { businessId: CARRIER } });
  await prisma.domainOutboxEvent.deleteMany({ where: { businessId: CARRIER } });

  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.apiKey.deleteMany({ where: { businessId: CARRIER } });

  await prisma.refreshToken.deleteMany({ where: { userId: ADMIN } });
  await prisma.user.deleteMany({ where: { id: ADMIN } });

  await prisma.businessEntitlement.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

function call(method: "GET" | "POST" | "DELETE" | "PATCH", url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as never }),
  });
}

/**
 * Waits for the trail to catch up.
 *
 * The entry rides the outbox on purpose — a revoke must not fail because the
 * audit row could not be written — so it lands a moment after the response.
 * Polling is what a caller would do; a fixed sleep would either be flaky or
 * slow, and usually both.
 */
async function waitForActivity(
  matches: (description: string) => boolean,
  timeoutMs = 25_000,
): Promise<{ description: string; action: string; status: string } | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await prisma.activity.findMany({
      where: { businessId: CARRIER },
      select: { description: true, action: true, status: true, type: true },
      orderBy: { created_at: "desc" },
      take: 50,
    });

    const found = rows.find((row) => matches(row.description ?? ""));

    if (found) {
      return {
        description: found.description ?? "",
        action: found.action ?? "",
        status: found.status ?? "",
      };
    }

    await new Promise((done) => setTimeout(done, 400));
  }

  return null;
}

describe("issuing a key", () => {
  let keyId = "";

  /** The full token, which the API shows exactly once, at creation. */
  let token = "";

  it("is written to the trail, with the prefix and the scopes", async () => {
    const response = await call("POST", `/integrations/api-key/${CARRIER}`, {
      name: "ERP da Auditoria",
      scopes: ["deliveries:read", "routes:read"],
    });

    expect(response.statusCode, response.body).toBe(201);

    keyId = response.json().data.id;
    token = response.json().data.token;

    const entry = await waitForActivity((description) =>
      description.includes("ERP da Auditoria"),
    );

    expect(
      entry,
      "emitir uma chave de API não deixou rastro na auditoria",
    ).not.toBeNull();

    // What an auditor needs: which key, and what it may do.
    expect(entry!.description).toContain("deliveries:read");
    expect(entry!.description).toContain("routes:read");
    expect(entry!.action).toBe("create");
  });

  it("and the secret is not in it, though the prefix is", async () => {
    /**
     * A key is `prefix.secret`, and only the second half is a secret. The
     * prefix is stored unhashed, printed on the screen and quoted in every
     * support conversation — it is HOW you say which key you mean, so an audit
     * entry without it would name nothing.
     *
     * The full token is shown once, in the creation response, and nowhere else
     * ever. An entry that quoted it would put a live credential in a feed
     * every colleague can read, and in every screenshot of that feed.
     */
    const rows = await prisma.activity.findMany({
      where: { businessId: CARRIER },
      select: { description: true },
    });

    const withPrefix = rows.filter((row) =>
      /tjk_live_[a-z0-9]+/.test(row.description ?? ""),
    );

    expect(
      withPrefix.length,
      "nenhuma entrada identifica a chave pelo prefixo",
    ).toBeGreaterThan(0);

    for (const row of rows) {
      // The dot is the whole difference: `prefix` alone is public,
      // `prefix.secret` is the credential.
      expect(
        /tjk_live_[a-z0-9]+\.[a-z0-9]+/.test(row.description ?? ""),
        `o segredo da chave vazou para a auditoria: ${row.description}`,
      ).toBe(false);
    }
  });

  it("and the key that came back actually opens the door", async () => {
    /**
     * The half of a revocation that a seeded row cannot prove.
     *
     * A key inserted into the database already revoked shows that the
     * middleware reads the column. It says nothing about whether REVOKING
     * takes effect on a key that is currently working — which is the thing an
     * operator is actually doing when something leaks. A cached lookup, a
     * `findUnique` whose result is memoised, a connection pool holding a
     * prepared read: any of them would leave a revoked credential alive until
     * the next deploy, and every test in this repository would still pass.
     *
     * So: use it, revoke it, use it again. In that order, over HTTP, with the
     * token the API handed back.
     */
    const response = await app.inject({
      method: "GET",
      url: "/integration/v1/deliveries",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  it("and revoking it is written too", async () => {
    const response = await call(
      "DELETE",
      `/integrations/api-key/${keyId}/business/${CARRIER}`,
    );

    expect(response.statusCode, response.body).toBe(200);

    const entry = await waitForActivity((description) =>
      description.includes("Chave de API revogada"),
    );

    expect(
      entry,
      "revogar uma chave de API não deixou rastro na auditoria",
    ).not.toBeNull();

    expect(entry!.action).toBe("delete");
    expect(entry!.status).toBe("Revogada");
  });

  it("and the door closes on the NEXT request, not on the next deploy", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/integration/v1/deliveries",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(
      response.statusCode,
      "a chave revogada continuou funcionando",
    ).toBe(401);

    // And the refusal says nothing about WHY. A distinct answer for "revoked"
    // and "never existed" is, together, an oracle for which keys are real.
    const forged = await app.inject({
      method: "GET",
      url: "/integration/v1/deliveries",
      headers: {
        authorization: `Bearer tjk_live_deadbeef.${"a".repeat(64)}`,
      },
    });

    expect(response.json().message).toBe(forged.json().message);
  });
});

describe("pointing a webhook somewhere", () => {
  let endpointId = "";

  it("is written to the trail, with the address and the topics", async () => {
    const response = await call("POST", `/integrations/webhook-endpoint/${CARRIER}`, {
      name: "ERP da Auditoria",
      url: "https://exemplo.com.br/webhooks/trajetto",
      topics: ["delivery.created", "route.released"],
      is_active: true,
    });

    expect(response.statusCode, response.body).toBe(201);

    endpointId = response.json().data.id;

    const entry = await waitForActivity((description) =>
      description.includes("exemplo.com.br/webhooks/trajetto"),
    );

    expect(
      entry,
      "criar um webhook não deixou rastro na auditoria",
    ).not.toBeNull();

    // The address is the point: every event of the operation goes there.
    expect(entry!.description).toContain("delivery.created");
  });

  it("and removing it is written too", async () => {
    const response = await call(
      "DELETE",
      `/integrations/webhook-endpoint/${endpointId}/business/${CARRIER}`,
    );

    expect(response.statusCode, response.body).toBe(200);

    const entry = await waitForActivity((description) =>
      description.includes("Webhook removido"),
    );

    expect(entry, "remover um webhook não deixou rastro").not.toBeNull();

    expect(entry!.action).toBe("delete");
  });

  it("and the signing secret never appears", async () => {
    // Same rule as the API key: the secret is shown once at creation.
    const rows = await prisma.activity.findMany({
      where: { businessId: CARRIER },
      select: { description: true },
    });

    for (const row of rows) {
      expect(
        /whsec_|secret/i.test(row.description ?? ""),
        `o segredo do webhook vazou para a auditoria: ${row.description}`,
      ).toBe(false);
    }
  });
});

describe("and the trail says who did it", () => {
  it("names the person, not the system", async () => {
    /**
     * An audit entry with no actor answers "what happened" and not "who", and
     * the second question is the one an audit exists for.
     */
    const rows = await prisma.activity.findMany({
      where: { businessId: CARRIER },
      select: { performedBy: true, type: true },
    });

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.performedBy, `atividade sem autor: ${row.type}`).toBe(ADMIN);
    }
  });
});

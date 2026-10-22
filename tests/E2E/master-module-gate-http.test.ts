import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * The MASTER and the module gate, through the real application (decision
 * 4.3: the gate applies to the MASTER, in reads and writes).
 *
 * The gate checks every company a MASTER request names. A request that names
 * NONE passes it, and that is only safe if no module route then serves some
 * company's data. It was not: the fleet lists and exports dropped the tenant
 * filter for the MASTER, so /admin/fuel read the fuelling, orders, payables,
 * fines, checklists, parts and suppliers of companies that never hired
 * FLEET. Those use cases now refuse a MASTER that names no company; this
 * file proves it for every module route where the company may be left out,
 * enumerated from the published document so a new such route fails here
 * until its answer is added to the table below.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const RUN = randomUUID().slice(0, 8);

// Fresh ids per run: other suites share this database.
const HIRED = randomUUID();
const BARE = randomUUID();
const INACTIVE_BARE = randomUUID();
const MISSING = randomUUID();

const MASTER = randomUUID();
const ANY = "018fe7a0-0000-7000-8000-00000000fb01";

let token = "";

let supplierBare = "";
let supplierHired = "";
let shipperBare = "";
let apiKeyHiredPrefix = "";

type Answer =
  /** A 4xx: the MASTER must name a company, or the route is not his. */
  | "refused"
  /** A 200 that carries no company's records (catalogues, own-scope reads). */
  | "no-company-data";

interface Probe {
  url: string;
  payload?: Record<string, unknown>;
  answer: Answer;
}

/**
 * Every module route where a MASTER may leave the company out, and what it
 * answers him. "refused" routes resolve the company from the request or the
 * session and refuse a MASTER with neither; "no-company-data" routes serve a
 * catalogue with no tenant data, or read the caller's own company (none, for
 * a MASTER).
 */
const MASTER_WITHOUT_COMPANY: Record<string, Probe> = {
  // The record names the company: its gate is checked on the record's
  // company, and an id that exists nowhere is a 404 (ai-analysis-routes).
  "GET /ai-analysis/progress/{recordType}/{recordId}": {
    url: `/ai-analysis/progress/fuel/${ANY}`,
    answer: "refused",
  },
  "POST /ai-analysis/request/{recordType}/{recordId}": {
    url: `/ai-analysis/request/fuel/${ANY}`,
    answer: "refused",
  },
  "GET /account-payable/export-account-payable": {
    url: "/account-payable/export-account-payable",
    answer: "refused",
  },
  "GET /account-payable/list-account-payable": {
    url: "/account-payable/list-account-payable?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /account-payable/search-account-payable-by-responsible-user": {
    url: "/account-payable/search-account-payable-by-responsible-user",
    answer: "no-company-data",
  },
  "GET /chat/attachment-url": {
    url: `/chat/attachment-url?messageId=${ANY}`,
    answer: "refused",
  },
  "GET /chat/list-messages": { url: "/chat/list-messages", answer: "refused" },
  "GET /chat/list-threads": {
    url: "/chat/list-threads?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /chat/recipients": { url: "/chat/recipients", answer: "refused" },
  "GET /chat/search-messages": {
    url: "/chat/search-messages?search=abc",
    answer: "refused",
  },
  "POST /chat/mark-delivered": {
    url: "/chat/mark-delivered",
    payload: { threadId: ANY },
    answer: "refused",
  },
  "POST /chat/mark-read": {
    url: "/chat/mark-read",
    payload: { threadId: ANY },
    answer: "refused",
  },
  "POST /chat/send-message": {
    url: "/chat/send-message",
    payload: { driverIds: [ANY], kind: "TEXT", body: "Olá" },
    answer: "refused",
  },
  // Support tickets (decision 14.5): a MASTER always names the company.
  "GET /chat/tickets": { url: "/chat/tickets?status=OPEN", answer: "refused" },
  "GET /chat/tickets/assignees": {
    url: "/chat/tickets/assignees",
    answer: "refused",
  },
  "GET /chat/tickets/summary": {
    url: "/chat/tickets/summary",
    answer: "refused",
  },
  "GET /chat/tickets/{ticketId}": {
    url: `/chat/tickets/${ANY}`,
    answer: "refused",
  },
  "GET /chat/tickets/{ticketId}/events": {
    url: `/chat/tickets/${ANY}/events`,
    answer: "refused",
  },
  "GET /chat/tickets/{ticketId}/messages": {
    url: `/chat/tickets/${ANY}/messages`,
    answer: "refused",
  },
  "POST /chat/tickets": {
    url: "/chat/tickets",
    payload: { driverId: ANY, subject: "Documentos" },
    answer: "refused",
  },
  "POST /chat/tickets/{ticketId}/assign": {
    url: `/chat/tickets/${ANY}/assign`,
    payload: { assigneeId: null },
    answer: "refused",
  },
  "POST /chat/tickets/{ticketId}/close": {
    url: `/chat/tickets/${ANY}/close`,
    payload: { outcome: "RESOLVED" },
    answer: "refused",
  },
  "POST /chat/tickets/{ticketId}/messages": {
    url: `/chat/tickets/${ANY}/messages`,
    payload: { kind: "TEXT", body: "Olá" },
    answer: "refused",
  },
  "POST /chat/tickets/{ticketId}/read": {
    url: `/chat/tickets/${ANY}/read`,
    payload: { readAt: "2026-10-05T12:00:00.000Z" },
    answer: "refused",
  },
  "POST /chat/tickets/{ticketId}/reopen": {
    url: `/chat/tickets/${ANY}/reopen`,
    payload: {},
    answer: "refused",
  },
  "GET /delivery/export-delivery": {
    url: "/delivery/export-delivery",
    answer: "refused",
  },
  "GET /delivery/export-occurrence": {
    url: "/delivery/export-occurrence",
    answer: "refused",
  },
  "GET /delivery/list-delivery": {
    url: "/delivery/list-delivery?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /delivery/list-occurrences": {
    url: "/delivery/list-occurrences?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /delivery/message-templates": {
    url: "/delivery/message-templates",
    answer: "refused",
  },
  "GET /delivery/operation-summary": {
    url: "/delivery/operation-summary",
    answer: "refused",
  },
  // The tower's queue (decision 6.3): 400 BUSINESS_NOT_IDENTIFIED for a
  // MASTER who names no company.
  "GET /delivery/occurrence-authorizations": {
    url: "/delivery/occurrence-authorizations",
    answer: "refused",
  },
  "GET /delivery/proof-audits": {
    url: "/delivery/proof-audits?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /fines/export-fine": { url: "/fines/export-fine", answer: "refused" },
  "GET /fines/list-fine": {
    url: "/fines/list-fine?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /fuel/export-fuel": { url: "/fuel/export-fuel", answer: "refused" },
  "GET /fuel/list-fuel": {
    url: "/fuel/list-fuel?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /fuel/search-fuel-by-vehicle/{vehicleId}": {
    url: `/fuel/search-fuel-by-vehicle/${ANY}`,
    answer: "refused",
  },
  "GET /import/download-template": {
    url: "/import/download-template",
    answer: "no-company-data",
  },
  "GET /import/list-imports": {
    url: "/import/list-imports?page=1&pageSize=5",
    answer: "refused",
  },
  // The integrations screens read the session's company when none is named;
  // a MASTER has none, so the answer is an empty list, never every company's.
  "GET /integrations/api-keys": {
    url: "/integrations/api-keys",
    answer: "no-company-data",
  },
  "GET /integrations/api-usage": {
    url: "/integrations/api-usage",
    answer: "no-company-data",
  },
  "GET /integrations/webhook-deliveries": {
    url: "/integrations/webhook-deliveries?page=1&pageSize=5",
    answer: "no-company-data",
  },
  "GET /integrations/webhook-endpoints": {
    url: "/integrations/webhook-endpoints",
    answer: "no-company-data",
  },
  "GET /occurrence-type/list-occurrence-type": {
    url: "/occurrence-type/list-occurrence-type?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /part/list-part": {
    url: "/part/list-part?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /route/control-tower": {
    url: "/route/control-tower",
    answer: "refused",
  },
  "GET /route/driver-trail/{driverId}": {
    url: `/route/driver-trail/${ANY}`,
    answer: "refused",
  },
  "GET /route/list-routes": {
    url: "/route/list-routes?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /route/monitoring": { url: "/route/monitoring", answer: "refused" },
  "GET /route/monitoring/drivers": {
    url: "/route/monitoring/drivers",
    answer: "refused",
  },
  "POST /route/positions": {
    url: "/route/positions",
    payload: {
      pings: [
        {
          latitude: -23.55,
          longitude: -46.63,
          recorded_at: new Date().toISOString(),
        },
      ],
    },
    answer: "refused",
  },
  "GET /service-order-part/list-service-order-part": {
    url: "/service-order-part/list-service-order-part?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /service-order/export-service-order": {
    url: "/service-order/export-service-order",
    answer: "refused",
  },
  "GET /service-order/list-service-order": {
    url: "/service-order/list-service-order?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /service-order/search-service-order-by-vehicle/{vehicleId}": {
    url: `/service-order/search-service-order-by-vehicle/${ANY}`,
    answer: "refused",
  },
  "GET /shipper/list-shipper": {
    url: "/shipper/list-shipper?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /status-change-reason/list-status-change-reason": {
    url: "/status-change-reason/list-status-change-reason?page=1&pageSize=5",
    answer: "refused",
  },
  "GET /supplier/list-supplier": {
    url: "/supplier/list-supplier?page=1&pageSize=5",
    answer: "refused",
  },
  // The Brazilian traffic code (CTB): the same list for every company.
  "GET /traffic-violation/list-traffic-violation-codes": {
    url: "/traffic-violation/list-traffic-violation-codes?page=1&pageSize=5",
    answer: "no-company-data",
  },
  "GET /traffic-violation/search-traffic-violation-codes": {
    url: "/traffic-violation/search-traffic-violation-codes",
    answer: "no-company-data",
  },
  "GET /vehicle-checklist/export-vehicle-checklist": {
    url: "/vehicle-checklist/export-vehicle-checklist",
    answer: "refused",
  },
  "GET /vehicle-checklist/list-vehicle-checklist": {
    url: "/vehicle-checklist/list-vehicle-checklist?page=1&pageSize=5",
    answer: "refused",
  },
};

interface DocumentOperation {
  "x-module"?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ in: string; name: string; required?: boolean }>;
  requestBody?: {
    content?: Record<string, { schema?: { required?: string[] } }>;
  };
}

/** The module routes behind a session where the company is not required. */
function companyOptionalModuleRoutes(): Array<{
  id: string;
  queryCompany: boolean;
}> {
  const document = app.swagger() as unknown as {
    paths: Record<string, Record<string, DocumentOperation>>;
  };

  return Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.entries(operations).flatMap(([method, operation]) => {
      if (!operation["x-module"]) return [];

      const bySession = (operation.security ?? []).some(
        (entry) => "bearerAuth" in entry,
      );
      if (!bySession) return [];

      const company = (operation.parameters ?? []).find(
        (parameter) => parameter.name === "businessId",
      );

      if (company && (company.in === "path" || company.required)) return [];

      const bodyRequires = Object.values(
        operation.requestBody?.content ?? {},
      ).some((media) => media.schema?.required?.includes("businessId"));
      if (bodyRequires) return [];

      return [
        {
          id: `${method.toUpperCase()} ${path}`,
          queryCompany: company?.in === "query",
        },
      ];
    }),
  );
}

async function seedBusiness(
  id: string,
  modules: ("FLEET" | "DELIVERIES")[],
  isActive = true,
): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Gate ${id.slice(0, 8)} ${RUN}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `gate-${id}@exemplo.com.br`,
      is_active: isActive,
    },
  });

  if (modules.length > 0) {
    await prisma.businessEntitlement.createMany({
      data: modules.map((module) => ({
        businessId: id,
        module,
        enabled: true,
      })),
    });
  }
}

beforeAll(async () => {
  await seedBusiness(HIRED, ["FLEET", "DELIVERIES"]);
  await seedBusiness(BARE, []);
  await seedBusiness(INACTIVE_BARE, [], false);

  await prisma.user.create({
    data: {
      id: MASTER,
      role: "MASTER",
      name: "Suporte",
      email: `gate-master-${RUN}@exemplo.com.br`,
      password: "nao-usado",
    },
  });

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: MASTER,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    {
      tokenType: "access",
      role: "MASTER",
      businessId: null,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: MASTER, expiresIn: "1h" },
  );

  supplierBare = (
    await prisma.supplier.create({
      data: {
        businessId: BARE,
        name: `Fornecedor sem frota ${RUN}`,
        cnpj: "11222333000181",
      },
    })
  ).id;

  supplierHired = (
    await prisma.supplier.create({
      data: {
        businessId: HIRED,
        name: `Fornecedor com frota ${RUN}`,
        cnpj: "11222333000181",
      },
    })
  ).id;

  shipperBare = (
    await prisma.shipper.create({
      data: { businessId: BARE, name: `Embarcador sem entregas ${RUN}` },
    })
  ).id;

  apiKeyHiredPrefix = `gate${RUN}`;

  await prisma.apiKey.create({
    data: {
      businessId: HIRED,
      name: `Chave ${RUN}`,
      prefix: apiKeyHiredPrefix,
      token_hash: randomUUID(),
      scopes: ["deliveries:read"],
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  const companies = [HIRED, BARE, INACTIVE_BARE];

  await prisma.apiKey.deleteMany({ where: { businessId: { in: companies } } });
  await prisma.shipper.deleteMany({ where: { businessId: { in: companies } } });
  await prisma.supplier.deleteMany({
    where: { businessId: { in: companies } },
  });

  await prisma.refreshToken.deleteMany({ where: { userId: MASTER } });
  await prisma.activity.deleteMany({
    where: {
      OR: [{ businessId: { in: companies } }, { performedBy: MASTER }],
    },
  });
  await prisma.user.deleteMany({ where: { id: MASTER } });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: companies } },
  });
  await prisma.business.deleteMany({ where: { id: { in: companies } } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

function call(method: string, url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });
}

/** Anything a leak would carry: the companies and the records seeded in them. */
function seededIds(): string[] {
  return [
    HIRED,
    BARE,
    supplierBare,
    supplierHired,
    shipperBare,
    apiKeyHiredPrefix,
  ];
}

describe("a MASTER request that names no company", () => {
  it("is possible only on the routes in the table", () => {
    const found = companyOptionalModuleRoutes()
      .map((route) => route.id)
      .sort();

    // A new module route where the company may be left out lands here until
    // its answer to a MASTER is added to MASTER_WITHOUT_COMPANY and proven.
    expect(found).toEqual(Object.keys(MASTER_WITHOUT_COMPANY).sort());
  });

  it.each(Object.entries(MASTER_WITHOUT_COMPANY))(
    "%s never serves a company's records",
    async (id, probe) => {
      const [method] = id.split(" ");
      const response = await call(method, probe.url, probe.payload);

      if (probe.answer === "refused") {
        expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
        expect(response.statusCode, response.body).toBeLessThan(500);
      } else {
        expect(response.statusCode, response.body).toBe(200);
      }

      for (const seeded of seededIds()) {
        expect(response.body, `${id} carried ${seeded}`).not.toContain(seeded);
      }
    },
  );
});

describe("a MASTER request that names a company without the module", () => {
  const withQueryCompany = () => {
    const inQuery = new Set(
      companyOptionalModuleRoutes()
        .filter((route) => route.queryCompany)
        .map((route) => route.id),
    );

    return Object.entries(MASTER_WITHOUT_COMPANY).filter(
      ([id]) => id.startsWith("GET ") && inQuery.has(id),
    );
  };

  it("is refused MODULE_NOT_ENABLED on every route that takes it in the query", async () => {
    const routes = withQueryCompany();

    // Most of the table takes the company in the query; a floor so that a
    // broken filter cannot pass with nothing to check.
    expect(routes.length).toBeGreaterThan(30);

    const wrong: string[] = [];

    for (const [id, probe] of routes) {
      const separator = probe.url.includes("?") ? "&" : "?";
      const response = await call(
        "GET",
        `${probe.url}${separator}businessId=${BARE}`,
      );

      if (
        response.statusCode !== 403 ||
        response.json().code !== "MODULE_NOT_ENABLED"
      ) {
        wrong.push(
          `${id} → ${response.statusCode} ${response.body.slice(0, 120)}`,
        );
      }
    }

    expect(wrong).toEqual([]);
  });

  it("cannot reach an unhired company's record through a hired one in the path", async () => {
    // The MASTER used to be exempt from "the record belongs to the company
    // in the path": naming a hired company let him edit (and move) a
    // supplier of a company without FLEET.
    const response = await app.inject({
      method: "PATCH",
      url: `/supplier/update-supplier/${supplierBare}/business/${HIRED}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `Renomeado ${RUN}`, cnpj: "11222333000181" },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("SUPPLIER_TENANT_MISMATCH");

    const row = await prisma.supplier.findUnique({
      where: { id: supplierBare },
    });

    expect(row?.businessId).toBe(BARE);
    expect(row?.name).toBe(`Fornecedor sem frota ${RUN}`);
  });
});

describe("the MASTER's module gate says the most basic reason first", () => {
  it("answers 404 TENANT_NOT_FOUND for a company that does not exist", async () => {
    // It used to answer MODULE_NOT_ENABLED, and the web offered to enable a
    // module on a company that is not there.
    for (const url of [
      `/supplier/list-supplier?page=1&pageSize=5&businessId=${MISSING}`,
      `/shipper/list-shipper?page=1&pageSize=5&businessId=${MISSING}`,
    ]) {
      const response = await call("GET", url);

      expect(response.statusCode, url).toBe(404);
      expect(response.json().code, url).toBe("TENANT_NOT_FOUND");
    }
  });

  it("answers TENANT_INACTIVE for a switched-off company without the module", async () => {
    for (const url of [
      `/supplier/list-supplier?page=1&pageSize=5&businessId=${INACTIVE_BARE}`,
      `/delivery/list-delivery?page=1&pageSize=5&businessId=${INACTIVE_BARE}`,
    ]) {
      const response = await call("GET", url);

      expect(response.statusCode, url).toBe(403);
      expect(response.json().code, url).toBe("TENANT_INACTIVE");
    }
  });

  it("still answers MODULE_NOT_ENABLED for an active company without it", async () => {
    const response = await call(
      "GET",
      `/supplier/list-supplier?page=1&pageSize=5&businessId=${BARE}`,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
  });

  it("reads a company that hired it (control)", async () => {
    const response = await call(
      "GET",
      `/supplier/list-supplier?page=1&pageSize=5&businessId=${HIRED}`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(supplierHired);
    expect(response.body).not.toContain(supplierBare);
  });
});

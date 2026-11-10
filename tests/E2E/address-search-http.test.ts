import { afterAll, beforeAll, describe, expect, it } from "vitest";

import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";

import { seedFleetDriver } from "./support/fleet-driver-seed";

/**
 * GET /address-search/:businessId over real HTTP, Redis included (plan
 * pin-search): "Fixar no mapa"'s search on the route page. The provider is
 * a local server that answers like LocationIQ's autocomplete and counts
 * what it was asked.
 *
 * - a session, the deliveries module and `delivery_manage:write`, never a
 *   driver; another company in the path meets the global tenant guard;
 * - a query the page never sends is refused before anything is asked;
 * - the answer has the documented shape, and the provider was asked in
 *   Brazil, in the delivery's city, with the key;
 * - the same search again comes from the company's cache, unasked;
 * - the provider is asked at most its 200 characters, and its 400 for one
 *   text fails that search alone, nothing paused;
 * - a company at its day's ceiling is told so (429 with retry-after) while
 *   another company searches on;
 * - with the search off, 503 with retry-after, and the provider unasked;
 * - one user gets 30 searches a minute.
 *
 * Fresh company ids per run: the cache and the day's counts live in Redis,
 * which outlives a run's database.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const COMPANY = randomUUID();
const OTHER = randomUUID();
const NO_MODULE = randomUUID();
const LIMITER = randomUUID();

const tokens = {
  manager: "",
  driver: "",
  other: "",
  noModule: "",
  limiter: "",
};

const provider = {
  server: http.createServer(),
  requests: [] as URL[],
};

const saved = {
  url: env.ADDRESS_SEARCH_URL,
  protocol: env.ADDRESS_SEARCH_PROTOCOL,
  key: env.ADDRESS_SEARCH_KEY,
  budget: env.ADDRESS_SEARCH_DAILY_BUDGET,
  businessLimit: env.ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT,
};

let providerUrl = "";

/**
 * LocationIQ's autocomplete: one street per search, "Nada" finds nothing,
 * "Recusa" and any text past its 200 characters answer 400.
 */
function answer(request: http.IncomingMessage, response: http.ServerResponse) {
  const url = new URL(request.url ?? "/", "http://provider.test");

  provider.requests.push(url);

  const q = url.searchParams.get("q") ?? "";

  response.setHeader("content-type", "application/json");

  if (q.startsWith("Nada")) {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Unable to geocode" }));
    return;
  }

  if (q.startsWith("Recusa") || q.length > 200) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "Invalid Request" }));
    return;
  }

  response.statusCode = 200;
  response.end(
    JSON.stringify([
      {
        place_id: `p-${q.length}`,
        lat: "-22.5084",
        lon: "-43.1735",
        class: "highway",
        type: "residential",
        display_name: `${q.split(",")[0]}, Centro, Petrópolis, Rio de Janeiro, Brasil`,
        address: {
          name: q.split(",")[0],
          road: q.split(",")[0],
          suburb: "Centro",
          city: "Petrópolis",
          state: "Rio de Janeiro",
          postcode: "25610-000",
          country_code: "br",
        },
      },
    ]),
  );
}

const search = (
  businessId: string,
  query: Record<string, string>,
  token?: string,
) =>
  app.inject({
    method: "GET",
    url: `/address-search/${businessId}?${new URLSearchParams(query).toString()}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const PETROPOLIS = { city: "Petrópolis", uf: "RJ" };

beforeAll(async () => {
  provider.server.on("request", answer);
  await new Promise<void>((resolve) =>
    provider.server.listen(0, "127.0.0.1", resolve),
  );
  providerUrl = `http://127.0.0.1:${(provider.server.address() as AddressInfo).port}/v1`;

  env.ADDRESS_SEARCH_URL = providerUrl;
  env.ADDRESS_SEARCH_PROTOCOL = "locationiq-autocomplete";
  env.ADDRESS_SEARCH_KEY = "e2e-search-key";
  // The platform's day is shared by every run on this Redis.
  env.ADDRESS_SEARCH_DAILY_BUDGET = 1_000_000;

  const company = await seedFleetDriver(prisma, {
    businessId: COMPANY,
    cnpj: "61222333000101",
  });
  const other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "61222333000282",
  });
  const noModule = await seedFleetDriver(prisma, {
    businessId: NO_MODULE,
    cnpj: "61222333000363",
  });
  const limiter = await seedFleetDriver(prisma, {
    businessId: LIMITER,
    cnpj: "61222333000444",
  });

  await prisma.businessEntitlement.updateMany({
    where: { businessId: NO_MODULE, module: "DELIVERIES" },
    data: { enabled: false },
  });

  tokens.manager = company.managerToken;
  tokens.driver = company.driverToken;
  tokens.other = other.managerToken;
  tokens.noModule = noModule.managerToken;
  tokens.limiter = limiter.managerToken;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  env.ADDRESS_SEARCH_URL = saved.url;
  env.ADDRESS_SEARCH_PROTOCOL = saved.protocol;
  env.ADDRESS_SEARCH_KEY = saved.key;
  env.ADDRESS_SEARCH_DAILY_BUDGET = saved.budget;
  env.ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT = saved.businessLimit;

  await new Promise<void>((resolve) => provider.server.close(() => resolve()));
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("who may search", () => {
  it("refuses a request without a session", async () => {
    const response = await search(COMPANY, { q: "Rua Epitácio Pessoa" });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a driver: the app does not search, and must not spend the company's day", async () => {
    const response = await search(
      COMPANY,
      { q: "Rua Epitácio Pessoa" },
      tokens.driver,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
  });

  it("refuses another company in the path", async () => {
    const response = await search(
      OTHER,
      { q: "Rua Epitácio Pessoa" },
      tokens.manager,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
  });

  it("refuses a company without the deliveries module", async () => {
    const response = await search(
      NO_MODULE,
      { q: "Rua Epitácio Pessoa" },
      tokens.noModule,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
  });

  it("asks the provider nothing for any of them", () => {
    expect(provider.requests).toHaveLength(0);
  });
});

describe("the query", () => {
  it.each([
    [{ q: "ab" }],
    [{ q: "x".repeat(201) }],
    [{ q: "Rua X", city: "Petrópolis" }],
    [{ q: "Rua X", city: "Petrópolis", uf: "XX" }],
    [{ q: "Rua X", viewbox: "-9.2,38.6,-9.0,38.8" }],
  ])("refuses %j before anything is asked", async (query) => {
    const before = provider.requests.length;
    const response = await search(COMPANY, query, tokens.manager);

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
    expect(provider.requests).toHaveLength(before);
  });
});

describe("the suggestions", () => {
  it("answer in the documented shape, asked in the delivery's city, in Brazil, with the key", async () => {
    const before = provider.requests.length;
    const response = await search(
      COMPANY,
      {
        q: "Rua Epitácio Pessoa, 120",
        ...PETROPOLIS,
        viewbox: "-43.30,-22.60,-43.00,-22.40",
      },
      tokens.manager,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        results: [
          {
            id: expect.any(String),
            title: "Rua Epitácio Pessoa",
            subtitle: "Centro, Petrópolis - RJ, 25610-000",
            latitude: -22.5084,
            longitude: -43.1735,
            precision: "STREET",
            city: "Petrópolis",
            uf: "RJ",
            bbox: null,
            inScope: true,
          },
        ],
        weak: false,
        scope: "CITY",
        cached: false,
      },
    });

    expect(provider.requests).toHaveLength(before + 1);

    const asked = provider.requests[before];

    expect(asked.pathname).toBe("/v1/autocomplete");
    expect(asked.searchParams.get("q")).toBe(
      "Rua Epitácio Pessoa, 120, Petrópolis, Rio de Janeiro",
    );
    expect(asked.searchParams.get("countrycodes")).toBe("br");
    expect(asked.searchParams.get("viewbox")).toBe("-43.3,-22.6,-43,-22.4");
    expect(asked.searchParams.get("key")).toBe("e2e-search-key");
    // The key never goes back to the browser.
    expect(response.body).not.toContain("e2e-search-key");
  });

  it("answer the same search again from the company's cache, unasked", async () => {
    const query = { q: "Rua Dom Pedro I, 10", ...PETROPOLIS };

    const first = await search(COMPANY, query, tokens.manager);
    const before = provider.requests.length;
    const second = await search(COMPANY, query, tokens.manager);

    expect(first.json().data.cached).toBe(false);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.cached).toBe(true);
    expect(second.json().data.results).toEqual(first.json().data.results);
    expect(provider.requests).toHaveLength(before);
  });

  it("ask the provider at most its 200 characters, the delivery's city included", async () => {
    const before = provider.requests.length;
    const long = `Rua ${"Muito Comprida ".repeat(14)}`.trim().slice(0, 200);
    const response = await search(
      COMPANY,
      { q: long, ...PETROPOLIS },
      tokens.manager,
    );

    expect(response.statusCode).toBe(200);
    expect(provider.requests).toHaveLength(before + 1);
    expect(
      provider.requests[before].searchParams.get("q")!.length,
    ).toBeLessThanOrEqual(200);
  });

  it("fail only that search when the provider rejects the text (400): the next one is asked", async () => {
    const rejected = await search(
      COMPANY,
      { q: "Recusa do provedor" },
      tokens.manager,
    );

    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().code).toBe("ADDRESS_SEARCH_UNAVAILABLE");
    expect(Number(rejected.headers["retry-after"])).toBeLessThanOrEqual(5);

    // Nothing paused (the pause is the platform's): the next search
    // reaches the provider.
    const before = provider.requests.length;
    const next = await search(
      COMPANY,
      { q: "Rua Depois da Recusa" },
      tokens.manager,
    );

    expect(next.statusCode).toBe(200);
    expect(provider.requests).toHaveLength(before + 1);
  });

  it("answer an empty list for nothing found, in the whole country without a city", async () => {
    const response = await search(
      COMPANY,
      { q: "Nada por aqui" },
      tokens.manager,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      results: [],
      weak: false,
      scope: "COUNTRY",
      cached: false,
    });
  });
});

describe("the limits", () => {
  it("tell a company at its day's ceiling so, while another company searches on", async () => {
    env.ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT = 1;

    try {
      const first = await search(
        OTHER,
        { q: "Rua do Imperador" },
        tokens.other,
      );
      const second = await search(OTHER, { q: "Rua Teresa" }, tokens.other);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(429);
      expect(second.json().code).toBe("ADDRESS_SEARCH_DAILY_LIMIT");
      expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);

      // A cached answer of the same company still comes, unspent.
      const cached = await search(
        OTHER,
        { q: "Rua do Imperador" },
        tokens.other,
      );

      expect(cached.statusCode).toBe(200);
      expect(cached.json().data.cached).toBe(true);
    } finally {
      env.ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT = saved.businessLimit;
    }

    const elsewhere = await search(
      COMPANY,
      { q: "Rua Teresa" },
      tokens.manager,
    );

    expect(elsewhere.statusCode).toBe(200);
  });

  it("answer 503 with the search off, and ask nothing", async () => {
    env.ADDRESS_SEARCH_URL = undefined;

    try {
      const before = provider.requests.length;
      const response = await search(
        COMPANY,
        { q: "Rua Nunca Buscada" },
        tokens.manager,
      );

      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("ADDRESS_SEARCH_UNAVAILABLE");
      expect(response.headers["retry-after"]).toBeDefined();
      expect(provider.requests).toHaveLength(before);
    } finally {
      env.ADDRESS_SEARCH_URL = providerUrl;
    }
  });

  it("give one user 30 searches a minute", async () => {
    const query = { q: "Rua do Limite", ...PETROPOLIS };
    const statuses: number[] = [];

    for (let index = 0; index < 31; index += 1) {
      statuses.push((await search(LIMITER, query, tokens.limiter)).statusCode);
    }

    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

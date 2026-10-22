import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import {
  API_SCOPES,
  RESERVED_API_SCOPES,
  generateApiKey,
} from "@/shared/integration/api-key-rules";

/**
 * The public reference against the API it describes, answer by answer.
 *
 * The reference published 401/403/404/500 as `{ message }` with
 * `additionalProperties: false`, while the handler sends `{ code, message }`:
 * a client generated from the document with strict validation rejected the
 * real refusal. And no operation said which scope it needs. Here every
 * keyed read of the published document is called for real — with no key,
 * with every scope but its own, with only its own, with a bad parameter and,
 * for a single resource, an id that does not exist — and each body is held
 * to the schema the document publishes for that status.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let document: Record<string, any>;

const CARRIER = "018f5000-0000-7000-8000-0000000d0c01";
const NO_MODULE = "018f5000-0000-7000-8000-0000000d0c02";

const keys = new Map<string, string>();

let noModuleKey: string;

async function seedBusiness(
  id: string,
  deliveries: boolean,
  cnpj: string,
): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  if (deliveries) {
    await prisma.businessEntitlement.create({
      data: { businessId: id, module: "DELIVERIES", enabled: true },
    });
  }
}

async function seedKey(businessId: string, scopes: string[]): Promise<string> {
  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Contrato da documentação",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes,
      businessId,
    },
  });

  return key.token;
}

const GRANTABLE = API_SCOPES.filter(
  (scope) => !RESERVED_API_SCOPES.includes(scope),
);

beforeAll(async () => {
  await seedBusiness(CARRIER, true, "11222999000110");
  await seedBusiness(NO_MODULE, false, "11222999000120");

  // One key per grantable scope, one with all of them, one per "all but".
  for (const scope of GRANTABLE) {
    keys.set(`only:${scope}`, await seedKey(CARRIER, [scope]));
    keys.set(
      `except:${scope}`,
      await seedKey(
        CARRIER,
        GRANTABLE.filter((other) => other !== scope),
      ),
    );
  }

  keys.set("all", await seedKey(CARRIER, [...GRANTABLE]));
  noModuleKey = await seedKey(NO_MODULE, [...GRANTABLE]);

  ({ app } = await import("@/http"));
  await app.ready();

  document = (
    await app.inject({ method: "GET", url: "/integration/docs/openapi.json" })
  ).json();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

interface Read {
  name: string;
  path: string;
  scope: string;
  operation: Record<string, any>;
  single: boolean;
}

/** The keyed reads the document publishes (writes are proven by their own suite). */
function keyedReads(): Read[] {
  return Object.entries(
    document.paths as Record<string, Record<string, any>>,
  ).flatMap(([path, item]) => {
    const operation = item.get;
    const requirement = operation?.security?.[0]?.apiKey;

    if (!requirement) return [];

    return [
      {
        name: `GET ${path}`,
        path,
        scope: requirement[0],
        operation,
        single: path.includes("{id}"),
      },
    ];
  });
}

function urlOf(path: string, id: string = randomUUID()): string {
  return path.replace("{id}", id);
}

function call(url: string, token?: string) {
  return app.inject({
    method: "GET",
    url,
    ...(token && { headers: { authorization: `Bearer ${token}` } }),
  });
}

/**
 * Whether `body` fits the published JSON Schema at its top level: every
 * required key there, no key the schema closes out, and each value of the
 * declared primitive type.
 */
function violations(
  body: Record<string, unknown>,
  schema: Record<string, any>,
): string[] {
  const problems: string[] = [];
  const properties: Record<string, any> = schema?.properties ?? {};

  for (const key of schema?.required ?? []) {
    if (!(key in body)) problems.push(`falta "${key}"`);
  }

  for (const [key, value] of Object.entries(body)) {
    const declared = properties[key];

    if (!declared) {
      if (schema?.additionalProperties === false)
        problems.push(`"${key}" não publicado`);
      continue;
    }

    const types = ([] as string[]).concat(declared.type ?? []);
    const actual = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value;

    if (types.length > 0 && !types.includes(actual)) {
      problems.push(`"${key}" é ${actual}, publicado ${types.join("|")}`);
    }

    if (declared.enum && !declared.enum.includes(value)) {
      problems.push(
        `"${key}" = ${String(value)} fora de ${declared.enum.join(",")}`,
      );
    }
  }

  return problems;
}

async function expectPublished(
  read: Read,
  response: Awaited<ReturnType<typeof call>>,
  label: string,
): Promise<void> {
  const status = String(response.statusCode);
  const published = read.operation.responses[status];

  expect(
    published,
    `${read.name} ${label}: ${status} não publicado`,
  ).toBeDefined();

  const schema = published.content?.["application/json"]?.schema;

  expect(
    violations(response.json(), schema),
    `${read.name} ${label} (${status})`,
  ).toEqual([]);

  // Published on every response, and actually sent on every one.
  expect(
    Object.keys(published.headers ?? {}),
    `${read.name} ${status}`,
  ).toContain("x-request-id");
  expect(
    response.headers["x-request-id"],
    `${read.name} ${label}`,
  ).toBeTruthy();
}

describe("the published document covers the keyed reads", () => {
  it("lists them, each with exactly one scope", () => {
    const reads = keyedReads();

    expect(reads.length).toBeGreaterThanOrEqual(5);

    for (const read of reads) {
      expect(read.operation.security[0].apiKey, read.name).toHaveLength(1);
    }
  });
});

describe("the scope each endpoint publishes is the one it enforces", () => {
  it("refuses every other scope and accepts its own", async () => {
    for (const read of keyedReads()) {
      const without = await call(
        urlOf(read.path),
        keys.get(`except:${read.scope}`),
      );

      expect(without.statusCode, `${read.name} sem ${read.scope}`).toBe(403);
      expect(without.json().code, read.name).toBe("MISSING_API_SCOPE");

      const only = await call(urlOf(read.path), keys.get(`only:${read.scope}`));

      // Its own scope is enough: 200 for a list, 404 for an unknown id.
      expect([200, 404], `${read.name} com ${read.scope}`).toContain(
        only.statusCode,
      );
    }
  });
});

describe("every refusal matches the schema published for its status", () => {
  it("without a key (401)", async () => {
    for (const read of keyedReads()) {
      const response = await call(urlOf(read.path));

      expect(response.statusCode, read.name).toBe(401);
      await expectPublished(read, response, "sem chave");
    }
  });

  it("without the scope (403)", async () => {
    for (const read of keyedReads()) {
      await expectPublished(
        read,
        await call(urlOf(read.path), keys.get(`except:${read.scope}`)),
        "sem escopo",
      );
    }
  });

  it("for a company without the module (403)", async () => {
    for (const read of keyedReads()) {
      const response = await call(urlOf(read.path), noModuleKey);

      expect(response.json().code, read.name).toBe("MODULE_NOT_ENABLED");
      await expectPublished(read, response, "sem módulo");
    }
  });

  it("for a bad parameter (400)", async () => {
    for (const read of keyedReads()) {
      const url = read.single
        ? urlOf(read.path, "nao-e-um-uuid")
        : `${read.path}?updated_since=ontem`;

      const response = await call(url, keys.get("all"));

      expect(response.statusCode, read.name).toBe(400);
      await expectPublished(read, response, "parâmetro inválido");
    }
  });

  it("for an id that does not exist (404)", async () => {
    for (const read of keyedReads().filter((entry) => entry.single)) {
      const response = await call(urlOf(read.path), keys.get("all"));

      expect(response.statusCode, read.name).toBe(404);
      await expectPublished(read, response, "id desconhecido");
    }
  });

  it("and a success too (200)", async () => {
    for (const read of keyedReads().filter((entry) => !entry.single)) {
      const response = await call(read.path, keys.get("all"));

      expect(response.statusCode, read.name).toBe(200);
      await expectPublished(read, response, "sucesso");
    }
  });
});

/**
 * The company ceiling's 429, header by header.
 *
 * The document says this refusal carries only `retry-after`. It carried the
 * KEY's `x-ratelimit-*` as well — set by the per-key limiter that ran first —
 * so a 429 read "remaining 119", which invites a client to keep calling.
 * Every keyed operation of the document, write included: the ceiling runs in
 * `onRequest`, before the scope or the body are looked at.
 */
describe("the company ceiling's 429 carries what the document says", () => {
  it("retry-after, the published body and none of the key's x-ratelimit-*", async () => {
    const { configureIntegrationRateGuard, unlimitedIntegrationRateGuard } =
      await import("@/shared/integration/integration-rate-guard");

    // The Redis counter is not under test: the company has spent its minute.
    configureIntegrationRateGuard({
      ...unlimitedIntegrationRateGuard,
      allowBusiness: async () => false,
    });

    try {
      const operations = Object.entries(
        document.paths as Record<string, Record<string, any>>,
      ).flatMap(([path, item]) =>
        Object.entries(item)
          .filter(([, operation]) => operation?.security?.[0]?.apiKey)
          .map(([method, operation]) => ({ path, method, operation })),
      );

      expect(operations.some((entry) => entry.method === "post")).toBe(true);

      for (const { path, method, operation } of operations) {
        const name = `${method.toUpperCase()} ${path}`;
        const response = await app.inject({
          method: method.toUpperCase() as "GET" | "POST",
          url: urlOf(path),
          headers: { authorization: `Bearer ${keys.get("all")}` },
        });

        expect(response.statusCode, name).toBe(429);
        expect(response.json().code, name).toBe("RATE_LIMITED");
        expect(Number(response.headers["retry-after"]), name).toBeGreaterThan(
          0,
        );

        expect(
          Object.keys(response.headers).filter((header) =>
            header.startsWith("x-ratelimit-"),
          ),
          name,
        ).toEqual([]);

        const published = operation.responses["429"];

        expect(published, `${name}: 429 não publicado`).toBeDefined();
        expect(published.description, name).toContain(
          "sem os cabeçalhos `x-ratelimit-*`",
        );
        expect(
          violations(
            response.json(),
            published.content["application/json"].schema,
          ),
          name,
        ).toEqual([]);
      }
    } finally {
      configureIntegrationRateGuard(unlimitedIntegrationRateGuard);
    }
  });

  it("while an allowed call still reports the key's ceiling", async () => {
    const response = await call("/integration/v1/deliveries", keys.get("all"));

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ratelimit-limit"]).toBeDefined();
    expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
  });
});

/**
 * The request example the document publishes, pasted as a reader would.
 *
 * The web reference built a body from the schema when the document had none,
 * and the API refused it with nine issues. The document now carries a real
 * one; here it is sent with the Idempotency-Key the reference's curl sets,
 * by a key holding only `deliveries:write`, to a company that has the
 * shipper it names — and must create the delivery, then replay it.
 */
describe("the published request example", () => {
  it("creates a delivery (201) and replays it with the same key (200)", async () => {
    const operation = document.paths["/integration/v1/deliveries"].post;
    const example = operation.requestBody.content["application/json"].example;

    expect(example, "o documento publica um exemplo de corpo").toBeDefined();

    await prisma.shipper.create({
      data: {
        name: "Embarcador do exemplo",
        cnpj: String(example.shipper_cnpj).replace(/\D/g, ""),
        businessId: CARRIER,
      },
    });

    const send = () =>
      app.inject({
        method: "POST",
        url: "/integration/v1/deliveries",
        headers: {
          authorization: `Bearer ${keys.get("only:deliveries:write")}`,
          "content-type": "application/json",
          "idempotency-key": "pedido-10452",
        },
        payload: JSON.stringify(example),
      });

    const created = await send();

    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      code: example.code,
      invoice_key: example.invoice_key,
      status: "PENDING",
    });
    expect(
      violations(
        created.json(),
        operation.responses["201"].content["application/json"].schema,
      ),
    ).toEqual([]);

    const replayed = await send();

    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.headers["idempotent-replayed"]).toBe("true");
    expect(replayed.json().id).toBe(created.json().id);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { RouteOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import {
  codedRefusal,
  errorResponse,
} from "@/routes/documentation/common-responses";
import { openapiTransform } from "@/routes/documentation/openapi-transform";

/**
 * The refusals for load, as the document lists them.
 *
 * A ServiceBusyError is the one refusal a client must retry rather than show
 * as a failure, and the `code` is how it tells: AUTH_BUSY from the bcrypt
 * gate, IMPORT_BUSY from the import queue (also while a replica drains for a
 * restart), EXPORT_BUSY from the export slots. IMPORT_BUSY used to live only
 * in the route's prose and AUTH_BUSY nowhere, so a client generated from
 * /docs saw neither. Merged lists used to read "Um destes: RATE_LIMITED. Um
 * destes: EXPORT_BUSY."; they are one list now.
 */
type Json = Record<string, any>;

const SRC = path.join(process.cwd(), "src");

/**
 * Every use case that runs a password or a one-time code through the bcrypt
 * gate, and the route that calls it. A new caller of the gate fails the first
 * test below until its route documents AUTH_BUSY.
 */
const GATED_USE_CASES: Record<string, string> = {
  "branch/usecases/delete-branch":
    "DELETE /branch/delete-branch/{branchId}/business/{businessId}",
  "branch/usecases/request-branch-deletion":
    "POST /branch/request-branch-deletion/{branchId}/business/{businessId}",
  "business/usecases/delete-business":
    "DELETE /business/delete-business/{businessId}",
  "business/usecases/request-business-deletion":
    "POST /business/request-business-deletion/{businessId}",
  "user/usecases/authenticate-user": "POST /user/session",
  "user/usecases/create-master-user": "POST /user/create-master-user",
  "user/usecases/create-user": "POST /user/create-user",
  "user/usecases/reset-user-password": "POST /user/reset/password",
  // Through verifyOneTimeCode: a code stored as bcrypt before the HMAC
  // format is still compared through the gate.
  "user/usecases/two-factor-verification": "POST /user/two-factor-verification",
  "user/usecases/update-user-password": "PATCH /user/password",
};

const IMPORT_QUEUE_ROUTES = [
  "POST /import/import-spreadsheet/{businessId}",
  "POST /import/reverse-import/{importId}/business/{businessId}",
];

let app: Awaited<typeof import("@/http")>["app"];
let document: Json;

beforeAll(async () => {
  ({ app } = await import("@/http"));

  await app.ready();

  document = app.swagger() as Json;
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) sourceFiles(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }

  return out;
}

function operation(id: string): Json {
  const [method, route] = id.split(" ");
  const found = document.paths?.[route]?.[method.toLowerCase()];

  if (!found) throw new Error(`Rota não documentada: ${id}`);

  return found;
}

function responseOf(id: string, status: string): Json {
  const response = operation(id).responses?.[status];

  if (!response) throw new Error(`${id} não documenta ${status}`);

  return response;
}

function codeDescription(response: Json): string {
  return (
    response.content?.["application/json"]?.schema?.properties?.code
      ?.description ?? ""
  );
}

/** The codes of a "Um destes: A, B." description; [] for prose. */
function listedCodes(response: Json): string[] {
  const match = /^Um destes: (.+)\.$/.exec(codeDescription(response));

  return match ? match[1].split(", ") : [];
}

const allResponses = () =>
  Object.entries<Json>(document.paths ?? {}).flatMap(([route, methods]) =>
    Object.entries<Json>(methods).flatMap(([method, op]) =>
      Object.entries<Json>(op.responses ?? {}).map(([status, response]) => ({
        id: `${method.toUpperCase()} ${route} ${status}`,
        response,
      })),
    ),
  );

describe("AUTH_BUSY (bcrypt gate)", () => {
  it("the table above names every use case that goes through the gate", () => {
    const modules = path.join(SRC, "modules");
    const gated = sourceFiles(modules)
      .filter((file) =>
        /\b(hashSecret|compareSecret|verifyOneTimeCode)\(/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => path.relative(modules, path.dirname(file)))
      .map((dir) => dir.split(path.sep).join("/"));

    expect([...new Set(gated)].sort()).toEqual(
      Object.keys(GATED_USE_CASES).sort(),
    );
  });

  it.each(Object.values(GATED_USE_CASES))(
    "%s lists AUTH_BUSY in its 503, with retry-after",
    (id) => {
      const unavailable = responseOf(id, "503");

      expect(listedCodes(unavailable)).toContain("AUTH_BUSY");
      expect(unavailable.description).toContain("AUTH_BUSY:");
      expect(unavailable.headers?.["retry-after"]).toBeDefined();
    },
  );

  it("keeps the session hook's codes next to it on a route behind a session", () => {
    expect(listedCodes(responseOf("PATCH /user/password", "503"))).toEqual([
      "AUTH_BUSY",
      "AUTH_SESSION_UNAVAILABLE",
      "SERVICE_UNAVAILABLE",
    ]);
  });
});

describe("IMPORT_BUSY (import queue)", () => {
  it.each(IMPORT_QUEUE_ROUTES)(
    "%s lists IMPORT_BUSY with RATE_LIMITED in one 429, with retry-after",
    (id) => {
      const tooMany = responseOf(id, "429");

      expect(listedCodes(tooMany)).toEqual(["IMPORT_BUSY", "RATE_LIMITED"]);
      expect(tooMany.description).toContain("reiniciando");
      expect(tooMany.headers?.["retry-after"]).toBeDefined();
    },
  );

  it("lists the reversal's two conflicts in its 409", () => {
    expect(
      listedCodes(
        responseOf(
          "POST /import/reverse-import/{importId}/business/{businessId}",
          "409",
        ),
      ),
    ).toEqual(["IMPORT_ALREADY_REVERSED", "IMPORT_IN_PROGRESS"]);
  });
});

describe("every ServiceBusyError code", () => {
  it("is in the code list of at least one documented response", () => {
    const thrown = new Set<string>();

    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, "utf8");

      for (const match of source.matchAll(
        /new ServiceBusyError\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`),\s*"([A-Z_]+)"/g,
      )) {
        thrown.add(match[1]);
      }
    }

    expect(thrown).toEqual(
      new Set([
        "AUTH_BUSY",
        "EXPORT_BUSY",
        "IMPORT_BUSY",
        "SOCKET_TICKET_UNAVAILABLE",
      ]),
    );

    const listed = new Set(
      allResponses().flatMap(({ response }) => listedCodes(response)),
    );

    for (const code of thrown) expect(listed, code).toContain(code);
  });
});

describe("merged code lists", () => {
  it("never repeat 'Um destes:' in one description", () => {
    const repeated = allResponses()
      .filter(
        ({ response }) =>
          (codeDescription(response).match(/Um destes:/g) ?? []).length > 1,
      )
      .map(({ id }) => id);

    expect(repeated).toEqual([]);
  });

  it("read as one list on every export's 429", () => {
    const exports = allResponses().filter(({ id }) =>
      / \/[\w-]+\/export-[\w-]+ 429$/.test(id),
    );

    expect(exports.length).toBeGreaterThanOrEqual(9);

    for (const { id, response } of exports) {
      expect(codeDescription(response), id).toBe(
        "Um destes: RATE_LIMITED, EXPORT_BUSY.",
      );
    }
  });

  function transformed(responses: Record<string, z.ZodTypeAny>): Json {
    const { schema } = openapiTransform({
      url: "/probe/:businessId",
      schema: {
        response: { 200: z.object({ ok: z.boolean() }), ...responses },
      } as never,
      route: {
        method: "POST",
        url: "/probe/:businessId",
        onRequest: [ensureAuthenticated],
      } as unknown as RouteOptions,
    }) as { schema: Json };

    return schema.response;
  }

  it("give a bare errorResponse the hook's list in place of the placeholder", () => {
    const responses = transformed({ 401: errorResponse, 429: errorResponse });

    expect(responses["401"].properties.code.description).toBe(
      "Um destes: AUTH_TOKEN_MISSING, AUTH_TOKEN_INVALID, AUTH_SESSION_INVALID, AUTH_SESSION_INVALIDATED.",
    );
    expect(responses["429"].properties.code.description).toBe(
      "Um destes: RATE_LIMITED.",
    );
  });

  it("do not close the list where the route's own prose names other codes", () => {
    const responses = transformed({
      403: errorResponse.describe("PROBE_FORBIDDEN: a sonda recusou."),
    });
    const description = responses["403"].properties.code.description;

    // PROBE_FORBIDDEN is only in the prose, so the code is not a closed list.
    expect(description).not.toMatch(/^Um destes:/);
    expect(description).toContain("TENANT_ACCESS_DENIED");
  });

  it("join a route's own list with the hook's", () => {
    const responses = transformed({
      429: codedRefusal("PROBE_BUSY: a sonda está cheia.", ["PROBE_BUSY"]),
      503: codedRefusal("SERVICE_UNAVAILABLE: repetido de propósito.", [
        "SERVICE_UNAVAILABLE",
      ]),
    });

    expect(responses["429"].properties.code.description).toBe(
      "Um destes: PROBE_BUSY, RATE_LIMITED.",
    );
    // A code both sides list appears once.
    expect(responses["503"].properties.code.description).toBe(
      "Um destes: SERVICE_UNAVAILABLE, AUTH_SESSION_UNAVAILABLE.",
    );
  });
});

describe("the routes of this round", () => {
  it("document the outbox events replay's refusals", () => {
    const id = "POST /health/dead-letter/events/replay";

    expect(listedCodes(responseOf(id, "400"))).toEqual([
      "VALIDATION_ERROR",
      "MALFORMED_REQUEST",
    ]);
    expect(listedCodes(responseOf(id, "403"))).toContain("AUTH_ROLE_FORBIDDEN");
    expect(responseOf(id, "429").description).toContain("10 por minuto");

    for (const status of ["200", "401", "503"]) {
      expect(operation(id).responses[status], status).toBeDefined();
    }
  });

  it("say the providers' report is shared through Redis, for 30 s or 5 s", () => {
    const report = responseOf("GET /health/providers", "200").content[
      "application/json"
    ].schema;
    const cached: string = report.properties.cached.description;

    expect(cached).toContain("Redis");
    expect(cached).toContain("30 s");
    expect(cached).toContain("5 s quando algum provedor está transitório");
  });
});

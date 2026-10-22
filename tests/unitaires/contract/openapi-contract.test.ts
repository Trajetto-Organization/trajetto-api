import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { ensureApiKey } from "@/modules/middlewares/ensure-api-key";
import {
  verifyBranchActive,
  verifyBusinessActive,
} from "@/modules/middlewares/verify-tenant-active";

import {
  introspectRoutes,
  type IntrospectedRoute,
  type OpenApiDocument,
  type OpenApiOperation,
} from "./support/introspect-routes";

/**
 * The document an integrator reads before writing a line of code, checked
 * against the routes that actually run.
 *
 * Swagger is generated from the route declarations, which means it is only as
 * honest as whoever added the last route remembered to be. Two failures
 * matter, and neither breaks anything at runtime:
 *
 *   * a route with no summary, tags or response schema is a route nobody
 *     outside this repository can use — it shows up in the page as an empty
 *     row;
 *   * a route that requires a token and does not SAY it requires one sends
 *     the integrator to debug a 401 that the document told them not to expect.
 *
 * Both used to be read off the document alone, and the document cannot catch
 * itself lying: @fastify/swagger fills a route with no `response` with a
 * placeholder 200, so "has responses" was always true, and `security` is
 * whatever somebody typed next to the hooks. The hooks are what run, so every
 * check here compares the two.
 *
 * A unit test and not an E2E one: building the document needs the router, not
 * a database.
 */
let routes: IntrospectedRoute[] = [];
let published: Array<IntrospectedRoute & { operation: OpenApiOperation }> = [];
let document: OpenApiDocument;
let close: () => Promise<void>;

/**
 * Everything that may be called with no token at all.
 *
 * Every entry is pre-authentication (you cannot hold a session while asking
 * for a password reset), tokenised by a link we issued (the customer's
 * tracking page), or deliberately public (the event catalogue, the probes).
 */
const ANONYMOUS = [
  "GET /health",
  "GET /health/liveness",
  "GET /health/readiness",
  "GET /integration/v1/catalogue",
  "GET /public/track/{token}",
  "GET /public/verify-proof/{token}",
  "GET /user/forgot-verification",
  "POST /public/track/{token}/opt-out",
  "POST /quote/create-quote",
  "POST /user/email-verification",
  "POST /user/forgot/password",
  "POST /user/refresh-token",
  "POST /user/resend-two-factor-code",
  "POST /user/reset/password",
  "POST /user/session",
  "POST /user/two-factor-verification",
];

const AUTH_HOOKS: unknown[] = [ensureAuthenticated, ensureApiKey];

function requiresCredential(route: Pick<IntrospectedRoute, "onRequest">) {
  return route.onRequest.some((hook) => AUTH_HOOKS.includes(hook));
}

/**
 * Routes whose published `security` disagrees with the hooks that run.
 *
 * Both directions are bugs: `security` without a hook is a route the document
 * calls protected and anybody can call; a hook without `security` is a 401
 * the document promised would not happen.
 */
function securityMismatches(
  candidates: Array<Pick<IntrospectedRoute, "id" | "onRequest" | "operation">>,
): string[] {
  return candidates
    .filter(
      (route) =>
        Boolean(route.operation?.security?.length) !==
        requiresCredential(route),
    )
    .map((route) => route.id);
}

/**
 * The generator's stand-in for "nobody described this": a lone 200 with the
 * default description and no body schema.
 */
function isPlaceholderOnly(operation: OpenApiOperation): boolean {
  const statuses = Object.keys(operation.responses ?? {});

  if (statuses.length === 0) return true;
  if (statuses.length > 1) return false;

  const only = operation.responses[statuses[0]];

  return only.description === "Default Response" && !only.content;
}

beforeAll(async () => {
  const introspected = await introspectRoutes();

  routes = introspected.routes;
  document = introspected.document;
  close = introspected.close;

  published = routes.filter(
    (route): route is IntrospectedRoute & { operation: OpenApiOperation } =>
      !route.hidden && route.operation !== undefined,
  );

  // If the document ever comes back nearly empty, everything below passes
  // vacuously — which is the shape of a test that guards nothing.
  expect(published.length, "o documento veio vazio").toBeGreaterThan(150);
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

describe("every published operation", () => {
  it("is paired with the route that serves it, so no check below skips one", () => {
    // Every check here runs over `published`, which pairs a registered route
    // with its operation by path. A route whose path the pairing misses would
    // drop out of all of them in silence — the anonymous list included.
    const paired = new Set(published.map(({ id }) => id));

    const unpaired = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.keys(methods)
        .map((method) => `${method.toUpperCase()} ${path}`)
        .filter((id) => !paired.has(id)),
    );

    expect(unpaired, "operações sem rota correspondente").toEqual([]);

    expect(
      routes
        .filter((route) => !route.hidden && !route.operation)
        .map(({ id }) => id),
      "rotas visíveis fora do documento",
    ).toEqual([]);
  });

  it("says what it does", () => {
    const missing = published
      .filter(({ operation }) => !operation.summary?.trim())
      .map(({ id }) => id);

    expect(missing, "operações sem summary").toEqual([]);
  });

  it("belongs to a section", () => {
    // Without a tag the operation lands in a nameless group at the bottom of
    // the page, which for a 240-operation document is the same as hiding it.
    const missing = published
      .filter(({ operation }) => !operation.tags?.length)
      .map(({ id }) => id);

    expect(missing, "operações sem tag").toEqual([]);
  });

  it("describes what comes back, not the generator's placeholder", () => {
    const missing = published
      .filter(({ operation }) => isPlaceholderOnly(operation))
      .map(({ id }) => id);

    expect(missing, "operações sem schema de resposta").toEqual([]);
  });
});

describe("what can be called without a token", () => {
  it("is exactly the list that is meant to be, read from the hooks", () => {
    const anonymous = published
      .filter((route) => !requiresCredential(route))
      .map(({ id }) => id)
      .sort();

    /**
     * An exact comparison, not a count.
     *
     * A route appearing here really is reachable with no token, which is a
     * decision somebody should make on purpose rather than discover in
     * production.
     */
    expect(anonymous).toEqual([...ANONYMOUS].sort());
  });

  it("is what the document says, route by route", () => {
    expect(securityMismatches(published)).toEqual([]);
  });

  it("catches a route that declares a token and never checks one (self-test)", () => {
    // The bug the old check could not see: it filtered on the declared
    // `security`, so a route with `security` and no hook passed as protected.
    const declaredOnly = {
      id: "GET /forgotten-hook",
      onRequest: [],
      operation: { security: [{ bearerAuth: [] }], responses: {} },
    };

    const hookOnly = {
      id: "GET /forgotten-security",
      onRequest: [ensureAuthenticated],
      operation: { responses: {} },
    };

    expect(securityMismatches([declaredOnly, hookOnly])).toEqual([
      "GET /forgotten-hook",
      "GET /forgotten-security",
    ]);
  });
});

/** The metadata a guard factory attaches to the hook it returns. */
interface GuardDoc {
  permission?: { key: string; access: "read" | "write" };
  roles?: string[];
  module?: string;
}

function guardsOf(route: IntrospectedRoute): GuardDoc[] {
  return route.preHandler
    .map((hook) => (hook as { openapi?: GuardDoc }).openapi)
    .filter((doc): doc is GuardDoc => doc !== undefined);
}

function statusesOf(route: { operation: OpenApiOperation }): string[] {
  return Object.keys(route.operation.responses);
}

describe("the refusals every client has to handle", () => {
  /**
   * A generated client only handles what the document lists. The two that
   * exist today handle 401, 403, 429 and 503 from knowledge nobody wrote
   * down — the app's outbox rules and the web's error mapper — and a third
   * written from /docs would treat a transient 503 as a logout, or retry a
   * revoked account forever.
   */
  const authenticated = () =>
    published.filter((route) => route.onRequest.includes(ensureAuthenticated));

  it("documents 401, 403 and 503 on every route behind a session", () => {
    expect(authenticated().length).toBeGreaterThan(200);

    const missing = authenticated().flatMap((route) =>
      ["401", "403", "503"]
        .filter((status) => !statusesOf(route).includes(status))
        .map((status) => `${route.id} → ${status}`),
    );

    expect(missing).toEqual([]);
  });

  it("says what each of those means, by code", () => {
    for (const route of authenticated()) {
      const body = JSON.stringify(route.operation.responses);

      expect(body, route.id).toContain("AUTH_TOKEN_INVALID");
      expect(body, route.id).toContain("AUTH_ACCESS_REVOKED");

      // The one a client must NOT read as a logout.
      expect(
        JSON.stringify(route.operation.responses["503"]),
        route.id,
      ).toContain("AUTH_SESSION_UNAVAILABLE");
    }
  });

  it("documents 401 and 403 on every route behind an API key", () => {
    const keyed = published.filter((route) =>
      route.onRequest.includes(ensureApiKey),
    );

    expect(keyed.length).toBeGreaterThan(0);

    for (const route of keyed) {
      expect(statusesOf(route), route.id).toEqual(
        expect.arrayContaining(["401", "403"]),
      );

      expect(JSON.stringify(route.operation.responses), route.id).toContain(
        "MISSING_API_SCOPE",
      );
    }
  });

  it("documents 429 and its headers on every route the limiter covers", () => {
    // The limiter is global: every route has a bucket, and 34 of them a
    // stricter one of their own. Only `rateLimit: false` opts out.
    const limited = published.filter(
      (route) => route.config.rateLimit !== false,
    );

    expect(limited.length).toBeGreaterThan(200);

    const missing = limited
      .filter((route) => {
        const response = route.operation.responses["429"];

        return (
          !response ||
          !response.headers?.["retry-after"] ||
          !response.headers?.["x-ratelimit-limit"]
        );
      })
      .map(({ id }) => id);

    expect(missing).toEqual([]);
  });

  it("names the permission a route requires", () => {
    const guarded = published.filter((route) =>
      guardsOf(route).some((guard) => guard.permission),
    );

    // verifyPermission sits on ~170 routes; a floor so that losing the
    // metadata fails here instead of passing with nothing to check.
    expect(guarded.length).toBeGreaterThan(150);

    for (const route of guarded) {
      const expected = guardsOf(route)
        .filter((guard) => guard.permission)
        .map((guard) => guard.permission);

      expect(route.operation["x-permissions"], route.id).toEqual(expected);

      for (const permission of expected) {
        expect(route.operation.description ?? "", route.id).toContain(
          permission!.key,
        );
      }

      expect(statusesOf(route), route.id).toContain("403");

      // Decision 4.1: the refusal has its own code, so a client can tell it
      // from MODULE_NOT_ENABLED (it used to be AppError's BAD_REQUEST).
      const forbidden = JSON.stringify(route.operation.responses["403"]);

      expect(forbidden, route.id).toContain("PERMISSION_DENIED");
      expect(forbidden, route.id).not.toContain("BAD_REQUEST");
    }
  });

  it("lists the tenant gates' refusals wherever they run", () => {
    const gated = published.filter(
      (route) =>
        route.preHandler.includes(verifyBusinessActive) ||
        route.preHandler.includes(verifyBranchActive),
    );

    expect(gated.length).toBeGreaterThan(20);

    for (const route of gated) {
      const responses = route.operation.responses;

      expect(statusesOf(route), route.id).toEqual(
        expect.arrayContaining(["403", "404"]),
      );

      if (route.preHandler.includes(verifyBusinessActive)) {
        expect(JSON.stringify(responses["403"]), route.id).toContain(
          "TENANT_INACTIVE",
        );
      }

      if (route.preHandler.includes(verifyBranchActive)) {
        expect(JSON.stringify(responses["403"]), route.id).toContain(
          "BRANCH_INACTIVE",
        );
      }
    }
  });

  it("tells the truth about the module gate and the MASTER (decision 4.3)", () => {
    // Every module route said "MASTER passa sempre" in its description while
    // its 403 said the opposite; the gate checks the MASTER on each company
    // the request names, and looks the company up first.
    const moduleRoutes = published.filter(
      (route) =>
        route.operation["x-module"] !== undefined &&
        route.onRequest.includes(ensureAuthenticated),
    );

    expect(moduleRoutes.length).toBeGreaterThan(100);

    /** Whether the request can name a company for the gate to look up. */
    const namesCompany = (operation: OpenApiOperation): boolean =>
      (operation.parameters ?? []).some(
        (parameter) => parameter.name === "businessId",
      ) ||
      Object.values(operation.requestBody?.content ?? {}).some((media) =>
        Boolean(
          (media.schema as { properties?: Record<string, unknown> } | undefined)
            ?.properties?.businessId,
        ),
      );

    let naming = 0;

    for (const route of moduleRoutes) {
      expect(route.operation.description ?? "", route.id).not.toContain(
        "MASTER passa",
      );
      expect(route.operation.description ?? "", route.id).toContain(
        "Vale também para o MASTER",
      );

      const forbidden = JSON.stringify(route.operation.responses["403"]);

      expect(forbidden, route.id).toContain("MODULE_NOT_ENABLED");

      if (!namesCompany(route.operation)) continue;

      naming += 1;

      expect(forbidden, route.id).toContain("TENANT_INACTIVE");
      expect(
        JSON.stringify(route.operation.responses["404"]),
        route.id,
      ).toContain("TENANT_NOT_FOUND");
    }

    // Nearly all of them name one; a floor so the branch above is exercised.
    expect(naming).toBeGreaterThan(100);
  });

  it("names the roles a route is restricted to", () => {
    const restricted = published.filter((route) =>
      guardsOf(route).some((guard) => guard.roles),
    );

    expect(restricted.length).toBeGreaterThan(20);

    for (const route of restricted) {
      const roles = guardsOf(route).flatMap((guard) => guard.roles ?? []);

      expect(route.operation["x-roles"], route.id).toEqual(roles);
      expect(
        JSON.stringify(route.operation.responses["403"]),
        route.id,
      ).toContain("AUTH_ROLE_FORBIDDEN");
    }
  });
});

describe("the writes the driver's app sends", () => {
  /**
   * The offline outbox is the flow most exposed to duplication, and its
   * contract lived only in the controllers: five writes parse their body by
   * hand (no `requestBody` in the document), the `Idempotency-Key` header that
   * makes a retry safe was not mentioned anywhere, and the 409/422 the outbox
   * classifies were not listed.
   */
  const byId = (id: string) => {
    const route = published.find((candidate) => candidate.id === id);

    if (!route) throw new Error(`Rota não publicada: ${id}`);

    return route;
  };

  const CREATE_FUEL = "POST /fuel/create-fuel/{businessId}";
  const UPDATE_FUEL = "PATCH /fuel/update-fuel/{fuelId}/business/{businessId}";
  const CREATE_CHECKLIST =
    "POST /vehicle-checklist/create-vehicle-checklist/{businessId}";
  const UPDATE_CHECKLIST =
    "PATCH /vehicle-checklist/update-vehicle-checklist/{checklistId}/business/{businessId}";

  it("documents a body on every write whose controller reads one", () => {
    const missing = published
      .filter(
        (route) =>
          ["POST", "PUT", "PATCH"].includes(route.method) &&
          String(route.handler).includes("request.body") &&
          !route.operation.requestBody,
      )
      .map(({ id }) => id);

    expect(missing).toEqual([]);
  });

  it("documents the Idempotency-Key header wherever it is read", () => {
    const readers = published.filter((route) =>
      String(route.handler).includes("idempotency-key"),
    );

    expect(readers.length).toBeGreaterThanOrEqual(2);

    const missing = readers
      .filter(
        (route) =>
          !route.operation.parameters?.some(
            (parameter) =>
              parameter.in === "header" &&
              parameter.name === "idempotency-key" &&
              Boolean(parameter.description),
          ),
      )
      .map(({ id }) => id);

    expect(missing).toEqual([]);
  });

  it("publishes the fields the fueling body really takes", () => {
    const body = JSON.stringify(byId(CREATE_FUEL).operation.requestBody);

    for (const field of [
      "photo",
      "key",
      "client_submission_id",
      "current_mileage",
    ]) {
      expect(body, field).toContain(`"${field}"`);
    }

    // What makes a replay safe has to be said where the field is.
    expect(body).toContain("Idempotency-Key");
  });

  it("lists the conflicts the outbox classifies", () => {
    const expected: Array<[string, string[]]> = [
      [CREATE_FUEL, ["409", "422"]],
      [CREATE_CHECKLIST, ["409", "422"]],
      // Moving a record to a deactivated branch is refused with 409
      // BRANCH_INACTIVE on the edit too, not only on the first send.
      [UPDATE_FUEL, ["409", "422"]],
      [UPDATE_CHECKLIST, ["409", "422"]],
      ["POST /delivery/proof/{deliveryId}/business/{businessId}", ["409"]],
      [
        "POST /delivery/report-occurrence/{deliveryId}/business/{businessId}",
        ["409"],
      ],
      [
        "PATCH /delivery/update-delivery-status/{deliveryId}/business/{businessId}",
        ["409"],
      ],
    ];

    for (const [id, statuses] of expected) {
      expect(statusesOf(byId(id)), id).toEqual(
        expect.arrayContaining(statuses),
      );
    }

    expect(JSON.stringify(byId(CREATE_FUEL).operation.responses)).toContain(
      "SUBMISSION_OWNER_MISMATCH",
    );
    expect(JSON.stringify(byId(CREATE_FUEL).operation.responses)).toContain(
      "DRIVER_INACTIVE",
    );

    for (const id of [UPDATE_FUEL, UPDATE_CHECKLIST]) {
      const conflict = JSON.stringify(byId(id).operation.responses["409"]);

      expect(conflict, id).toContain("BRANCH_INACTIVE");
      // An edit carries no idempotency key, so it cannot collide with one.
      expect(conflict, id).not.toContain("SUBMISSION_OWNER_MISMATCH");
    }
  });
});

/**
 * Every place a 2xx body says nothing: a property or an array item whose
 * schema is `{}` — what `z.unknown()` becomes. A free-form map
 * (`additionalProperties`) is a deliberate "any key" and is not counted.
 */
function unknownShapes(schema: unknown, path: string, found: string[]): void {
  if (!schema || typeof schema !== "object") return;

  const node = schema as Record<string, unknown>;

  for (const [name, child] of Object.entries(
    (node.properties ?? {}) as Record<string, unknown>,
  )) {
    if (isEmptySchema(child)) found.push(`${path}.${name}`);
    else unknownShapes(child, `${path}.${name}`, found);
  }

  if (node.items) {
    if (isEmptySchema(node.items)) found.push(`${path}[]`);
    else unknownShapes(node.items, `${path}[]`, found);
  }

  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    for (const member of (node[combinator] ?? []) as unknown[]) {
      unknownShapes(member, path, found);
    }
  }
}

function isEmptySchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;

  return Object.keys(schema).every((key) =>
    ["description", "nullable", "example"].includes(key),
  );
}

describe("what the document says about the bodies that come back", () => {
  it("gives every operation a success response", () => {
    // The downloads used to publish only 400 and 500: a client could not
    // tell from the document that the call ever succeeds, or with what.
    const missing = published
      .filter((route) => !statusesOf(route).some((status) => /^2/.test(status)))
      .map(({ id }) => id);

    expect(missing).toEqual([]);
  });

  it("publishes the downloads as files, with the name they are saved under", () => {
    const downloads = published.filter(
      (route) =>
        /\/export-[a-z-]+$/.test(route.openapiPath) ||
        route.openapiPath === "/import/download-template",
    );

    // Nine plus the accounts payable report (fleet-finance, decision 8.4).
    expect(downloads.length).toBe(10);

    for (const route of downloads) {
      const success = route.operation.responses["200"];
      const types = Object.keys(success?.content ?? {});

      expect(types, route.id).not.toContain("application/json");
      expect(
        types.some(
          (type) => type === "text/csv" || type.includes("spreadsheetml"),
        ),
        route.id,
      ).toBe(true);
      expect(success?.headers?.["content-disposition"], route.id).toBeDefined();

      // Only the export writers set Access-Control-Expose-Headers; the
      // template controller does not, so a browser cannot read its name.
      expect(
        JSON.stringify(success).includes("Access-Control-Expose-Headers"),
        route.id,
      ).toBe(route.openapiPath !== "/import/download-template");
    }
  });

  it("says what is inside every success body, instead of `unknown`", () => {
    const found: string[] = [];

    for (const route of published) {
      for (const [status, response] of Object.entries(
        route.operation.responses,
      )) {
        if (!/^2/.test(status)) continue;

        for (const [type, media] of Object.entries(response.content ?? {})) {
          unknownShapes(media.schema, `${route.id} ${status} ${type}`, found);
        }
      }
    }

    expect(found).toEqual([]);
  });

  it("describes every query parameter", () => {
    const missing = published.flatMap((route) =>
      (route.operation.parameters ?? [])
        .filter(
          (parameter) =>
            parameter.in === "query" &&
            !parameter.description?.trim() &&
            !(parameter.schema?.description as string | undefined)?.trim(),
        )
        .map((parameter) => `${route.id} ?${parameter.name}`),
    );

    expect(missing).toEqual([]);
  });

  it("documents a wrong password on login as the 401 it is", () => {
    // authenticate-user-controller answers 401 AUTH_INVALID_CREDENTIALS; the
    // document said 400 "Credenciais inválidas!", so a client built from it
    // handled a wrong password on the 400 branch and fell into the generic
    // 401 one — the "session expired" path.
    const session = published.find(
      (route) => route.id === "POST /user/session",
    );
    const responses = session!.operation.responses;

    expect(Object.keys(responses)).toContain("401");
    expect(JSON.stringify(responses["401"])).toContain(
      "AUTH_INVALID_CREDENTIALS",
    );
    expect(JSON.stringify(responses["400"])).not.toContain(
      "Credenciais inválidas",
    );
  });

  it("does not validate the e-mail of /user/me as if it were input", () => {
    // A response schema that re-validates stored data turns one legacy
    // address into a 500 on the call every session starts with.
    const me = published.find((route) => route.id === "GET /user/me");

    expect(JSON.stringify(me?.operation.responses["200"])).not.toContain(
      '"format":"email"',
    );
  });
});

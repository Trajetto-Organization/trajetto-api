import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The published contract of the route module, read back out of the running
 * application rather than out of the file that declares it.
 *
 * Swagger here is generated from the same zod schemas the controllers parse
 * with, so most of it cannot drift. What CAN drift — and what this file is
 * for — is the part written by hand: the list of statuses each route claims to
 * answer with. A documented status nobody can trigger sends a client down a
 * branch that never runs, and a missing one leaves a real failure undescribed;
 * both are worse than no documentation, because both are believed.
 *
 * It also proves the document builds at all. A zod schema the OpenAPI
 * transformer cannot represent does not fail a typecheck and does not fail a
 * unit test — it fails when somebody opens /docs.
 */
interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: unknown[];
  responses: Record<string, unknown>;
  requestBody?: unknown;
}

type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
};

let document: OpenApiDocument;
let close: () => Promise<void>;

/** Every documented operation under the /route prefix, flattened. */
function operations(): Array<[string, string, OpenApiOperation]> {
  return Object.entries(document.paths)
    .filter(([path]) => path.startsWith("/route/"))
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(
        ([method, operation]) =>
          [path, method, operation] as [string, string, OpenApiOperation],
      ),
    );
}

function operationFor(path: string): OpenApiOperation {
  const found = operations().find(([candidate]) => candidate === path);

  if (!found) {
    throw new Error(`Rota não documentada: ${path}`);
  }

  return found[2];
}

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  document = app.swagger() as unknown as OpenApiDocument;
  close = () => app.close();
}, 60_000);

afterAll(async () => {
  await close?.();
});

describe("the route module's published surface", () => {
  it("publishes exactly the ten endpoints the module implements", () => {
    // Listed rather than counted: a route added without documentation, or one
    // documented and never registered, both show up here as a diff instead of
    // a number that happens to match.
    expect(operations().map(([path, method]) => `${method.toUpperCase()} ${path}`))
      .toEqual([
        "POST /route/create-route/{businessId}",
        "GET /route/list-routes",
        "GET /route/get-route/{routeId}/business/{businessId}",
        "PATCH /route/update-route/{routeId}/business/{businessId}",
        "PATCH /route/release-route/{routeId}/business/{businessId}",
        "POST /route/start-route/{routeId}/business/{businessId}",
        "PATCH /route/cancel-route/{routeId}/business/{businessId}",
        "POST /route/add-stops/{routeId}/business/{businessId}",
        "DELETE /route/remove-stop/{stopId}/route/{routeId}/business/{businessId}",
        "PATCH /route/reorder-stops/{routeId}/business/{businessId}",
      ]);
  });

  it("declares a bearer token on every one of them", () => {
    for (const [path, method, operation] of operations()) {
      expect(operation.security, `${method} ${path}`).toBeTruthy();
    }
  });

  it("tags and describes every one of them", () => {
    for (const [path, method, operation] of operations()) {
      expect(operation.tags, `${method} ${path}`).toEqual(["route"]);
      expect(operation.summary, `${method} ${path}`).toBeTruthy();

      // The description is where the behaviour that is NOT in the schema
      // lives — which refusals happen, and what the caller does about them.
      expect(
        (operation.description ?? "").length,
        `${method} ${path}`,
      ).toBeGreaterThan(80);
    }
  });
});

describe("the statuses each route claims to answer", () => {
  it("documents 409 on every write that has a precondition", () => {
    // These all write behind a `where` that can match nothing — the route
    // moved, the vehicle went out, the delivery was taken. The frontend has a
    // single handler for "refresh and try again" keyed on 409, and a route
    // that does not publish it is a route whose conflict lands on the generic
    // error toast.
    const withPreconditions = [
      "/route/create-route/{businessId}",
      "/route/update-route/{routeId}/business/{businessId}",
      "/route/release-route/{routeId}/business/{businessId}",
      "/route/start-route/{routeId}/business/{businessId}",
      "/route/cancel-route/{routeId}/business/{businessId}",
      "/route/add-stops/{routeId}/business/{businessId}",
      "/route/reorder-stops/{routeId}/business/{businessId}",
    ];

    for (const path of withPreconditions) {
      expect(Object.keys(operationFor(path).responses), path).toContain(
        "409",
      );
    }
  });

  it("does not claim 409 where nothing can conflict", () => {
    // Removing a stop and the two reads answer 404 for every refusal they
    // have, including "the route already departed" — there is no state they
    // can half-apply, so a 409 here would be documentation of a branch that
    // does not exist.
    for (const path of [
      "/route/list-routes",
      "/route/get-route/{routeId}/business/{businessId}",
      "/route/remove-stop/{stopId}/route/{routeId}/business/{businessId}",
    ]) {
      expect(Object.keys(operationFor(path).responses), path).not.toContain(
        "409",
      );
    }
  });

  it("claims 429 only where a rate limit is actually configured", () => {
    // The driver's app resends from its outbox after a dead network, so the
    // departure carries a limit. Nothing else in the module does, and saying
    // otherwise would have the app back off from a wall that is not there.
    const limited = operations().filter(([, , operation]) =>
      Object.keys(operation.responses).includes("429"),
    );

    expect(limited.map(([path]) => path)).toEqual([
      "/route/start-route/{routeId}/business/{businessId}",
    ]);
  });

  it("documents 404 wherever a route id is addressed", () => {
    // Cross-tenant answers 404 here, not 403 — a distinct "exists but is not
    // yours" tells a caller which ids are real. So every id-addressed route
    // publishes 404 and the client must not read it as "definitely deleted".
    for (const [path, method, operation] of operations()) {
      if (!path.includes("{routeId}")) continue;

      expect(Object.keys(operation.responses), `${method} ${path}`).toContain(
        "404",
      );
    }
  });

  it("describes a real body on every route that parses one", () => {
    const withBody = [
      "/route/create-route/{businessId}",
      "/route/update-route/{routeId}/business/{businessId}",
      "/route/release-route/{routeId}/business/{businessId}",
      "/route/start-route/{routeId}/business/{businessId}",
      "/route/cancel-route/{routeId}/business/{businessId}",
      "/route/add-stops/{routeId}/business/{businessId}",
      "/route/reorder-stops/{routeId}/business/{businessId}",
    ];

    for (const path of withBody) {
      expect(operationFor(path).requestBody, path).toBeTruthy();
    }
  });
});

describe("the shapes it publishes", () => {
  it("does not publish an empty object where a schema was meant to be", () => {
    // A zod construct the transformer cannot represent degrades to `{}`
    // instead of failing. That is the quiet way documentation becomes a lie:
    // the page still renders, and every field is gone.
    const emptied: string[] = [];

    for (const [path, method, operation] of operations()) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const schema = (
          response as {
            content?: { "application/json"?: { schema?: Record<string, unknown> } };
          }
        ).content?.["application/json"]?.schema;

        if (!schema) continue;

        const described =
          schema.properties !== undefined ||
          schema.$ref !== undefined ||
          schema.allOf !== undefined ||
          schema.type === "array";

        if (!described) emptied.push(`${method} ${path} → ${status}`);
      }
    }

    expect(emptied).toEqual([]);
  });

  it("publishes the stop order and its outcome on the detail response", () => {
    // The two fields the driver's app and the panel are actually built on.
    const detail = operationFor(
      "/route/get-route/{routeId}/business/{businessId}",
    );

    const schema = JSON.stringify(
      (detail.responses["200"] as Record<string, unknown>) ?? {},
    );

    expect(schema).toContain("sequence");
    expect(schema).toContain("ARRIVED");
    expect(schema).toContain("progress");
  });
});

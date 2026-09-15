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

/** Every documented operation under a prefix, flattened. */
function operationsUnder(prefix: string): Array<[string, string, OpenApiOperation]> {
  return Object.entries(document.paths)
    .filter(([path]) => path.startsWith(prefix))
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(
        ([method, operation]) =>
          [path, method, operation] as [string, string, OpenApiOperation],
      ),
    );
}

const operations = () => operationsUnder("/route/");

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
  it("publishes exactly the thirteen endpoints the module implements", () => {
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

        // The control tower. The ingest is a driver surface; the other two
        // are the manager's, and a driver token is refused rather than shown
        // the whole operation.
        "POST /route/positions",
        "GET /route/control-tower",
        "GET /route/driver-trail/{driverId}",
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
    // departure carries a limit — and so does the position ingest, which is
    // the busiest route in the product by an order of magnitude. Nothing else
    // in the module does, and saying otherwise would have the app back off
    // from a wall that is not there.
    const limited = operations().filter(([, , operation]) =>
      Object.keys(operation.responses).includes("429"),
    );

    expect(limited.map(([path]) => path).sort()).toEqual([
      "/route/positions",
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

  it("warns that the listing is NDJSON and not JSON", () => {
    // The one response in the module whose shape a client can get wrong in a
    // way no status code reveals: calling response.json() on a stream throws
    // a parse error that looks like a server fault. The wire format is proven
    // byte by byte in the integration suite; this pins that the documentation
    // still says so.
    const listing = operationFor("/route/list-routes").description ?? "";

    expect(listing).toContain("ndjson");
    expect(listing).toContain("searchMeta");
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

describe("the status-override catalogue's published surface", () => {
  /**
   * The vocabulary behind "por que essa entrega está assim?".
   *
   * Checked here rather than in a file of its own because booting the
   * application costs ten seconds and one document answers for both modules.
   */
  const catalogue = () => operationsUnder("/status-change-reason/");

  it("publishes exactly the four endpoints a catalogue needs", () => {
    expect(
      catalogue().map(([path, method]) => `${method.toUpperCase()} ${path}`),
    ).toEqual([
      "POST /status-change-reason/create-status-change-reason/{businessId}",
      "GET /status-change-reason/list-status-change-reason",
      "PATCH /status-change-reason/update-status-change-reason/{reasonId}/business/{businessId}",
      "DELETE /status-change-reason/delete-status-change-reason/{reasonId}/business/{businessId}",
    ]);
  });

  it("declares a bearer token and a tag on every one of them", () => {
    for (const [path, method, operation] of catalogue()) {
      expect(operation.security, `${method} ${path}`).toBeTruthy();
      expect(operation.tags, `${method} ${path}`).toEqual([
        "statusChangeReason",
      ]);
    }
  });

  it("claims 409 only where a reason can be in use", () => {
    // Deleting a reason the catalogue already spent is the one refusal here
    // that is not the caller's fault: the request was well formed and allowed,
    // and the reason is simply part of the record now.
    const withConflict = catalogue()
      .filter(([, , operation]) =>
        Object.keys(operation.responses).includes("409"),
      )
      .map(([path]) => path);

    expect(withConflict).toEqual([
      "/status-change-reason/delete-status-change-reason/{reasonId}/business/{businessId}",
    ]);
  });

  it("warns that the listing is NDJSON and not JSON", () => {
    const listing =
      catalogue().find(([path]) =>
        path.endsWith("/list-status-change-reason"),
      )?.[2].description ?? "";

    expect(listing).toContain("ndjson");
  });

  it("does not publish an empty object where a schema was meant to be", () => {
    // A zod construct the transformer cannot represent degrades to `{}`
    // instead of failing — the quiet way documentation becomes a lie.
    const emptied: string[] = [];

    for (const [path, method, operation] of catalogue()) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const schema = (
          response as {
            content?: {
              "application/json"?: { schema?: Record<string, unknown> };
            };
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
});

describe("the delivery status override, as published", () => {
  it("demands a reason in the body", () => {
    // The one endpoint in the module that moves a status without something
    // having happened in the field. Everything the driver's app does carries
    // its own evidence; an override carries none, so the reason IS it.
    const override = Object.entries(document.paths).find(([path]) =>
      path.includes("/delivery/update-delivery-status/"),
    );

    expect(override).toBeDefined();

    const body = JSON.stringify(
      (override![1].patch as OpenApiOperation).requestBody ?? {},
    );

    expect(body).toContain("reasonId");
    expect(body).toContain("required");
  });
});

describe("the import module's published surface", () => {
  /**
   * Loading a day's work from a spreadsheet, and taking it back.
   *
   * The two responses here that a client can get wrong in a way no status code
   * reveals are both documented by hand: the listing is a stream, and both the
   * template download and the exports are FILES. A caller who reads either as
   * JSON gets a parse error that looks like a server fault.
   */
  const imports = () => operationsUnder("/import/");

  it("publishes exactly the four endpoints the module implements", () => {
    expect(
      imports().map(([path, method]) => `${method.toUpperCase()} ${path}`),
    ).toEqual([
      "GET /import/download-template",
      "POST /import/import-spreadsheet/{businessId}",
      "GET /import/list-imports",
      "POST /import/reverse-import/{importId}/business/{businessId}",
    ]);
  });

  it("declares a bearer token, a tag and a real description on every one", () => {
    for (const [path, method, operation] of imports()) {
      expect(operation.security, `${method} ${path}`).toBeTruthy();
      expect(operation.tags, `${method} ${path}`).toEqual(["import"]);

      expect(
        (operation.description ?? "").length,
        `${method} ${path}`,
      ).toBeGreaterThan(80);
    }
  });

  it("claims 409 only on the undo", () => {
    // The undo is the one call here with a precondition it can lose: the
    // upload may already have been reversed, or may still be running.
    const withConflict = imports()
      .filter(([, , operation]) =>
        Object.keys(operation.responses).includes("409"),
      )
      .map(([path]) => path);

    expect(withConflict).toEqual([
      "/import/reverse-import/{importId}/business/{businessId}",
    ]);
  });

  it("warns that the listing is NDJSON and not JSON", () => {
    const listing =
      imports().find(([path]) => path.endsWith("/list-imports"))?.[2]
        .description ?? "";

    expect(listing).toContain("ndjson");
  });

  it("warns that the template is a file and not JSON", () => {
    const template =
      imports().find(([path]) => path.endsWith("/download-template"))?.[2]
        .description ?? "";

    expect(template).toContain(".xlsx");

    // And it publishes no 200 schema, because there is no JSON body to
    // describe — documenting one would be describing a response that never
    // arrives.
    const responses = Object.keys(
      imports().find(([path]) => path.endsWith("/download-template"))![2]
        .responses,
    );

    expect(responses).not.toContain("200");
  });

  it("describes the per-row report on the upload, not just a count", () => {
    // "Qual das duzentas falhou?" is the whole reason the response is not a
    // number. A contract that published only the totals would let a client be
    // built that cannot answer it.
    const upload = Object.entries(document.paths).find(([path]) =>
      path.includes("/import/import-spreadsheet/"),
    );

    const body = JSON.stringify(
      (upload![1].post as OpenApiOperation).responses["200"] ?? {},
    );

    expect(body).toContain("unknownHeaders");
    expect(body).toContain("outcome");
    expect(body).toContain("line");
  });
});

describe("the delivery exports, as published", () => {
  const exports = () =>
    operationsUnder("/delivery/export-").map(
      ([path, method, operation]) =>
        [path, method, operation] as [string, string, OpenApiOperation],
    );

  it("publishes both of them", () => {
    expect(
      exports().map(([path, method]) => `${method.toUpperCase()} ${path}`),
    ).toEqual(["GET /delivery/export-delivery", "GET /delivery/export-occurrence"]);
  });

  it("publishes no 200 schema, because the answer is a file", () => {
    for (const [path, method, operation] of exports()) {
      expect(Object.keys(operation.responses), `${method} ${path}`).not.toContain(
        "200",
      );

      expect(operation.description ?? "", `${method} ${path}`).toContain(
        "NÃO com JSON",
      );
    }
  });
});

describe("the public integration API, as published", () => {
  /**
   * The one surface in the product whose contract belongs to somebody else's
   * engineering team. A route renamed here is an integration broken in
   * production at a customer we cannot deploy for.
   */
  const integration = () => operationsUnder("/integration/v1/");

  it("publishes the read surface a v1 promises", () => {
    expect(
      integration().map(([path, method]) => `${method.toUpperCase()} ${path}`),
    ).toEqual([
      "GET /integration/v1/catalogue",
      "GET /integration/v1/deliveries",
      "GET /integration/v1/deliveries/{id}",
      "GET /integration/v1/routes",
      "GET /integration/v1/routes/{id}",
      "GET /integration/v1/events",
    ]);
  });

  it("leaves the catalogue open and gates everything else on a key", () => {
    // The catalogue is what somebody reads BEFORE integrating; requiring a key
    // to learn what the topics are is how a first attempt stalls.
    for (const [path, method, operation] of integration()) {
      if (path.endsWith("/catalogue")) {
        expect(operation.security, `${method} ${path}`).toBeUndefined();
        continue;
      }

      expect(operation.security, `${method} ${path}`).toEqual([{ apiKey: [] }]);
    }
  });

  it("never offers a session token where a key belongs", () => {
    // A JWT is a person's session; an API key is a machine with scopes. A
    // document that called them the same thing would have integrators sending
    // the wrong credential.
    for (const [path, method, operation] of integration()) {
      expect(
        JSON.stringify(operation.security ?? []),
        `${method} ${path}`,
      ).not.toContain("bearerAuth");
    }
  });

  it("takes no businessId anywhere", () => {
    // The company comes from the key and from nowhere else. A public API that
    // accepted it as a parameter would be one where a customer can ask for
    // another's operation — and it would pass every test written by somebody
    // who only ever sent their own id.
    for (const [path, method, operation] of integration()) {
      const parameters = JSON.stringify(
        (operation as unknown as { parameters?: unknown }).parameters ?? [],
      );

      expect(parameters, `${method} ${path}`).not.toContain("businessId");
    }
  });

  it("documents 429 on every route that is rate limited", () => {
    // The limit is per key. An integrator who does not know it exists writes a
    // loop that discovers it at 3am.
    for (const [path, method, operation] of integration()) {
      if (path.endsWith("/catalogue")) continue;

      expect(Object.keys(operation.responses), `${method} ${path}`).toContain(
        "429",
      );
    }
  });

  it("publishes a cursor and never a page number", () => {
    // `OFFSET 40000` makes Postgres count forty thousand rows to throw them
    // away — and an offset page shifts when a row is inserted mid-walk, which
    // is how an integration silently skips a document.
    for (const [path, method, operation] of integration()) {
      if (!path.endsWith("/deliveries") && !path.endsWith("/routes") && !path.endsWith("/events")) {
        continue;
      }

      const parameters = JSON.stringify(
        (operation as unknown as { parameters?: unknown }).parameters ?? [],
      );

      expect(parameters, `${method} ${path}`).toContain("cursor");
      expect(parameters, `${method} ${path}`).not.toContain('"page"');

      const success = JSON.stringify(operation.responses["200"] ?? {});

      expect(success, `${method} ${path}`).toContain("next_cursor");
    }
  });

  it("carries the three identifiers on every document it returns", () => {
    // Our id, the customer's own code, and the NF-e key. An integration that
    // can only match on one of those breaks the first time a customer's ERP
    // changes how it numbers things.
    const delivery = JSON.stringify(
      integration().find(([path]) => path === "/integration/v1/deliveries")![2]
        .responses["200"] ?? {},
    );

    expect(delivery).toContain('"id"');
    expect(delivery).toContain('"code"');
    expect(delivery).toContain('"invoice_key"');
  });

  it("does not leak an internal column into a published shape", () => {
    // The shapes are written as projections, never as a spread of the row —
    // a spread means every column added tomorrow is silently published.
    const published = JSON.stringify(
      integration().map(([, , operation]) => operation.responses),
    );

    for (const internal of [
      "businessId",
      "importId",
      "shipperId",
      "driverId",
      "client_submission_id",
      "reasonId",
    ]) {
      expect(published, internal).not.toContain(internal);
    }
  });
});

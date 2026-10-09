import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";
import type { ZodTypeAny } from "zod";

import { documentedDocFor } from "@/routes/documentation/doc-only-responses";

import { strictIssues } from "./support/deep-strict";
import { introspectRoutes, type IntrospectedRoute } from "./support/introspect-routes";

/**
 * The success bodies an integrator and the driver's app live on, shown by
 * example.
 *
 * The public API and the driver's delivery loop are the two surfaces written
 * against by people outside this repository, and until now their 2xx carried
 * a schema and nothing else: no example in /docs nor in the public portal
 * (/integration/docs), so the first real payload anyone saw was in production.
 * Each example here is checked against the schema it illustrates, every field
 * and no more, so an example cannot drift into describing a body the API does
 * not send. Documentation only: the runtime schemas are untouched.
 */
const DRIVER_LOOP = [
  "GET /delivery/my-deliveries/{businessId}",
  "GET /delivery/get-delivery/{deliveryId}/business/{businessId}",
  "POST /delivery/start-route/{businessId}",
  "POST /delivery/arrival/{deliveryId}/business/{businessId}",
  "POST /delivery/proof/{deliveryId}/business/{businessId}",
  "POST /delivery/report-occurrence/{deliveryId}/business/{businessId}",
];

let routes: IntrospectedRoute[] = [];
let app: Awaited<ReturnType<typeof introspectRoutes>>["app"];
let close: () => Promise<void>;

beforeAll(async () => {
  const introspected = await introspectRoutes();

  routes = introspected.routes;
  app = introspected.app;
  close = introspected.close;
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

function successOf(route: IntrospectedRoute): { status: string; runtime: ZodTypeAny } {
  const responses = (route.schema?.response ?? {}) as Record<string, ZodTypeAny>;
  const status = Object.keys(responses).find((code) => /^2\d\d$/.test(code));

  if (!status) throw new Error(`${route.id}: sem resposta 2xx declarada`);

  return { status, runtime: responses[status] };
}

function publishedExample(route: IntrospectedRoute, status: string): unknown {
  return route.operation?.responses?.[status]?.content?.["application/json"] as
    | { example?: unknown }
    | undefined;
}

function covered(): IntrospectedRoute[] {
  const publicApi = routes.filter((route) => route.url.startsWith("/integration/v1/"));

  const driver = DRIVER_LOOP.map((id) => {
    const route = routes.find((candidate) => candidate.id === id);

    if (!route) throw new Error(`${id}: rota não encontrada`);

    return route;
  });

  return [...publicApi, ...driver];
}

describe("the 2xx of the public API and of the driver's loop", () => {
  it("carries an example in the published document", () => {
    const routesCovered = covered();

    // Six public reads today; a vacuous pass would guard nothing.
    expect(
      routesCovered.filter((route) => route.url.startsWith("/integration/v1/")).length,
    ).toBeGreaterThanOrEqual(6);

    const missing = routesCovered
      .filter((route) => {
        const { status } = successOf(route);
        const media = publishedExample(route, status) as { example?: unknown } | undefined;

        return media?.example === undefined;
      })
      .map(({ id }) => id);

    expect(missing, "2xx sem exemplo no documento").toEqual([]);
  });

  it("shows a body the schema describes, field for field", () => {
    const wrong = covered().flatMap((route) => {
      const { status, runtime } = successOf(route);
      const media = publishedExample(route, status) as { example?: unknown } | undefined;

      if (media?.example === undefined) return [];

      // Pass-through bodies are held to the typed shape the document shows.
      const shape = documentedDocFor(runtime) ?? runtime;

      return strictIssues(shape, media.example).map(
        (issue) => `${route.id}: ${issue}`,
      );
    });

    expect(wrong).toEqual([]);
  });

  it("is what the serializer would send for it: nothing stripped, nothing added", () => {
    const changed = covered().flatMap((route) => {
      const { status, runtime } = successOf(route);
      const media = publishedExample(route, status) as { example?: unknown } | undefined;

      if (media?.example === undefined) return [];

      const sent = JSON.parse(JSON.stringify(runtime.parse(media.example)));

      return JSON.stringify(sent) === JSON.stringify(media.example) ? [] : [route.id];
    });

    expect(changed).toEqual([]);
  });

  it("reaches the public portal an integrator actually reads", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/integration/docs/openapi.json",
    });

    const portal = response.json() as {
      paths: Record<string, Record<string, OpenApiOperationLike>>;
    };

    const media =
      portal.paths["/integration/v1/deliveries/{id}"]?.get?.responses?.["200"]
        ?.content?.["application/json"];

    expect(response.statusCode).toBe(200);
    expect(media?.example).toMatchObject({ status_label: "Em rota" });
  });
});

interface OpenApiOperationLike {
  responses?: Record<
    string,
    { content?: Record<string, { example?: unknown }> }
  >;
}

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { httpSurfaceHook } from "@/shared/http/http-surface";
import type { HttpSurface } from "@/shared/lifecycle/process-role";

/**
 * The routes each role answers (plano-escala F3-01; the security review of
 * the plan).
 *
 * A worker has no Domain, but it shares the dokploy-network with every other
 * environment's containers: answering the whole API there was a second door
 * to every route, one hostname away from a container of another project. So
 * the roles without public traffic answer /health* only (the image's
 * HEALTHCHECK and the deploy's checks need it), the ingest role adds the
 * positions, and everything else gets the 404 of a route that does not
 * exist — the same body and headers, so a hidden route cannot be told from
 * a missing one.
 *
 * The real application, booted as a worker: what the accept criterion
 * names. The other surfaces on a bare Fastify with the same hook.
 */

type App = Awaited<typeof import("@/http")>["app"];

let app: App;

const previousRole = process.env.PROCESS_ROLE;

beforeAll(async () => {
  // Before the first import of the environment in this file: the env module
  // parses process.env once, when it is first loaded.
  process.env.PROCESS_ROLE = "worker";
  vi.resetModules();

  ({ app } = await import("@/http"));
  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();

  if (previousRole === undefined) delete process.env.PROCESS_ROLE;
  else process.env.PROCESS_ROLE = previousRole;
});

/** What a response says about itself, without what differs per request. */
function shapeOf(response: Awaited<ReturnType<App["inject"]>>, path: string) {
  const headers = { ...response.headers };

  delete headers.date;
  delete headers["x-request-id"];
  delete headers["content-length"];

  return {
    statusCode: response.statusCode,
    headers,
    body: response.body.replace(path, "<path>"),
  };
}

describe("a process with PROCESS_ROLE=worker", () => {
  it("answers 404 on /delivery exactly as on a route that does not exist", async () => {
    const hidden = await app.inject({
      method: "GET",
      url: "/delivery/list-delivery",
    });
    const missing = await app.inject({
      method: "GET",
      url: "/delivery/no-such-route",
    });

    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().code).toBe("ROUTE_NOT_FOUND");
    expect(shapeOf(hidden, "/delivery/list-delivery")).toEqual(
      shapeOf(missing, "/delivery/no-such-route"),
    );
  });

  it("hides the positions and the public documentation too", async () => {
    for (const [method, url] of [
      ["POST", "/route/positions"],
      ["GET", "/integration/docs/openapi.json"],
      ["GET", "/config/map"],
    ] as const) {
      const response = await app.inject({ method, url, payload: undefined });

      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.headers["x-error-code"], `${method} ${url}`).toBe(
        "ROUTE_NOT_FOUND",
      );
    }
  });

  it("still answers the image's HEALTHCHECK", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/liveness",
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("the other surfaces", () => {
  async function surfaceApp(surface: HttpSurface) {
    const instance = Fastify();

    instance.addHook("onRequest", httpSurfaceHook(surface));

    for (const url of [
      "/health",
      "/health/readiness",
      "/delivery/list-delivery",
      "/route/positions",
    ]) {
      instance.all(url, async () => ({ ok: true }));
    }

    instance.setNotFoundHandler((_request, reply) =>
      reply.status(404).send({ code: "ROUTE_NOT_FOUND" }),
    );

    await instance.ready();

    return instance;
  }

  it.each([
    ["all", [200, 200, 200, 200]],
    ["health", [200, 200, 404, 404]],
    ["realtime", [200, 200, 404, 404]],
    ["ingest", [200, 200, 404, 200]],
  ] as const)("%s", async (surface, expected) => {
    const instance = await surfaceApp(surface);

    try {
      const statuses = [];

      for (const url of [
        "/health",
        "/health/readiness",
        "/delivery/list-delivery",
        "/route/positions",
      ]) {
        statuses.push(
          (await instance.inject({ method: "POST", url })).statusCode,
        );
      }

      expect(statuses).toEqual(expected);
    } finally {
      await instance.close();
    }
  });

  it("judges by the matched route, never by a path that only looks like /health", async () => {
    const instance = await surfaceApp("health");

    try {
      for (const url of [
        "/health/../delivery/list-delivery",
        "//delivery/list-delivery",
        "/%64elivery/list-delivery",
        "/healthz",
      ]) {
        const response = await instance.inject({ method: "GET", url });

        expect(response.statusCode, url).toBe(404);
      }
    } finally {
      await instance.close();
    }
  });
});

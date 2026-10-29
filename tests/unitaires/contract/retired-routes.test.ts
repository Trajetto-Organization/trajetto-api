import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import {
  introspectRoutes,
  type IntrospectedRoute,
} from "./support/introspect-routes";

/**
 * An endpoint this release removed answers 410, not 404.
 *
 * The web deploys on its own schedule and a phone keeps its build for as long
 * as its driver does not update it. Both still hold URLs from the release
 * before this one: a settings tab left open, the old fine deletion, the
 * WhatsApp pairing screen. To them a bare 404 ROUTE_NOT_FOUND is
 * indistinguishable from a typo, and nobody reading the log can tell which
 * build is still calling what. A tombstone says the endpoint is gone ON
 * PURPOSE, in Portuguese, names what replaced it when something did, and logs
 * the caller's build — which is how anyone knows when the tombstone itself
 * can go.
 *
 * No database: nothing below reaches a handler that queries.
 */
const API_ROOT = process.cwd();

/**
 * What origin/main served and this branch does not, method and shape.
 * Computed once from `git show origin/main:src/routes/*` against this
 * branch's router; kept literal here so the expectation does not depend on
 * the table it is checking.
 */
const REMOVED_SINCE_MAIN = [
  { method: "PATCH", url: "/user/email-notifications" },
  { method: "PATCH", url: "/user/activity-notifications" },
  {
    method: "DELETE",
    url: "/fines/delete-fine/018f0000-0000-7000-8000-000000000001",
  },
  { method: "GET", url: "/whatsapp/status" },
  { method: "GET", url: "/whatsapp/connect/qrcode" },
  { method: "POST", url: "/whatsapp/webhook/instancia-antiga" },
] as const;

const OLD_BUILD = "platform=android; version=1.3.0; build=30; contract=1";

type LogLine = { context: Record<string, unknown>; message: string };

const lines: LogLine[] = [];

let app: Awaited<ReturnType<typeof introspectRoutes>>["app"];
let routes: IntrospectedRoute[] = [];
let close: () => Promise<void>;

beforeAll(async () => {
  ({ app } = await import("@/http"));

  // Before ready(): the route plugins are deferred, so this root hook runs on
  // every one of them. It records what the request logs and keeps the real
  // logger underneath for everything else.
  app.addHook("onRequest", async (request) => {
    const real = request.log;
    const record = (context: unknown, message?: string) => {
      if (typeof message === "string") {
        lines.push({ context: context as Record<string, unknown>, message });
      }
    };

    request.log = Object.assign(Object.create(real), {
      info: record,
      warn: record,
    });
  });

  const introspected = await introspectRoutes();

  routes = introspected.routes;
  close = introspected.close;
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

describe("an endpoint removed since the last release", () => {
  it("answers 410 ENDPOINT_RETIRED, in Portuguese, instead of 404", async () => {
    for (const { method, url } of REMOVED_SINCE_MAIN) {
      const response = await app.inject({
        method,
        url,
        headers: { "x-trajetto-client-version": OLD_BUILD },
        ...(method === "GET" ? {} : { payload: {} }),
      });

      expect(response.statusCode, `${method} ${url}`).toBe(410);
      expect(response.headers["x-error-code"], `${method} ${url}`).toBe(
        "ENDPOINT_RETIRED",
      );

      const body = response.json();

      expect(body.code).toBe("ENDPOINT_RETIRED");
      expect(body.message).toMatch(/descontinuad/);
    }
  });

  it("names the endpoint that replaced it, when one did", async () => {
    const replacements = await Promise.all(
      [
        ["PATCH", "/user/email-notifications"],
        ["DELETE", "/fines/delete-fine/018f0000-0000-7000-8000-000000000001"],
        ["POST", "/whatsapp/webhook/instancia-antiga"],
      ].map(
        async ([method, url]) =>
          (
            await app.inject({ method: method as "PATCH", url, payload: {} })
          ).json().replacement,
      ),
    );

    expect(replacements).toEqual([
      "PUT /notification/preferences",
      "DELETE /fines/delete-fine/:fineId/business/:businessId",
      undefined,
    ]);
  });

  it("logs which build is still calling it", async () => {
    lines.length = 0;

    await app.inject({
      method: "PATCH",
      url: "/user/activity-notifications",
      headers: { "x-trajetto-client-version": OLD_BUILD },
      payload: {},
    });

    const line = lines.find(({ message }) => /retired endpoint/i.test(message));

    expect(line?.context).toMatchObject({
      client: OLD_BUILD,
      retired: "PATCH /user/activity-notifications",
    });
  });

  it("still answers 404 for a path that never existed", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/whatsapp/status-v2",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("ROUTE_NOT_FOUND");
  });
});

describe("the retired-routes table", () => {
  it("never shadows or duplicates an endpoint that still exists", async () => {
    const { RETIRED_ROUTES } = await import("@/routes/retired-routes");

    // Parameter names do not count: /a/:id and /a/:fineId are one route.
    const shape = (method: string, url: string) =>
      `${method} ${url.replace(/:[A-Za-z0-9_]+/g, ":p")}`;

    expect(routes.length).toBeGreaterThan(150);

    // Each tombstone is the ONLY route with its method and shape: nothing
    // live answers there, so nothing live is being retired.
    for (const { method, url } of RETIRED_ROUTES) {
      expect(
        routes.filter(
          (route) => shape(route.method, route.url) === shape(method, url),
        ),
        `${method} ${url}`,
      ).toHaveLength(1);
    }
  });

  it("stays out of the published document", async () => {
    const { RETIRED_ROUTES } = await import("@/routes/retired-routes");

    for (const { method, url } of RETIRED_ROUTES) {
      const route = routes.find(
        (candidate) => candidate.method === method && candidate.url === url,
      );

      expect(route?.hidden, `${method} ${url}`).toBe(true);
    }
  });
});

/**
 * Whatever main served when this branch left it, this branch serves or
 * retires.
 *
 * Only where a clone has origin/main to read (a developer's machine; a
 * shallow CI checkout may not): a route deleted without a tombstone fails here
 * by name, which is the reminder the runbook's expand/contract rule needs.
 */
function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: API_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * The fork point, not origin/main's tip. A branch cut before main gained a
 * route would otherwise read that route as removed HERE and be told to
 * tombstone it — and that tombstone would collide with main's live route, and
 * refuse to boot, the moment the two are merged. Routes this branch removed
 * are exactly the ones the fork point has and the working tree does not.
 */
const FORK_POINT = git(["merge-base", "HEAD", "origin/main"])?.trim() || null;

function mainSource(path: string): string | null {
  return FORK_POINT ? git(["show", `${FORK_POINT}:${path}`]) : null;
}

function mainRoutes(): string[] | null {
  const root = mainSource("src/routes/routes.ts");
  if (!root) return null;

  const imports = new Map<string, string>();

  for (const match of root.matchAll(
    /import\s+\{?\s*([A-Za-z]+)[^;]*?from\s+"\.\/([^"]+)"/g,
  )) {
    imports.set(match[1], match[2]);
  }

  const found: string[] = [];

  for (const match of root.matchAll(
    /register\(\s*([A-Za-z]+)\s*(?:,\s*\{\s*prefix:\s*"([^"]*)"\s*\})?\s*\)/g,
  )) {
    const file = imports.get(match[1]);
    const source = file ? mainSource(`src/routes/${file}.ts`) : null;
    if (!source) continue;

    for (const route of source.matchAll(
      /app\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g,
    )) {
      const url = `${match[2] ?? ""}${route[2]}`.replace(/\/+$/, "") || "/";

      found.push(`${route[1].toUpperCase()} ${url}`);
    }
  }

  return found;
}

const onMain = mainRoutes();

describe.skipIf(onMain === null)(
  "every route main served where this branch left it",
  () => {
    it("is still served here, or retired with a tombstone", () => {
      const shape = (id: string) => id.replace(/:[A-Za-z0-9_]+/g, ":p");

      const served = new Set(
        routes.map(({ method, url }) => shape(`${method} ${url}`)),
      );

      const dropped = (onMain ?? []).filter((id) => !served.has(shape(id)));

      expect(onMain?.length ?? 0).toBeGreaterThan(100);
      expect(
        dropped,
        "removidas sem tombstone em src/routes/retired-routes.ts",
      ).toEqual([]);
    });
  },
);

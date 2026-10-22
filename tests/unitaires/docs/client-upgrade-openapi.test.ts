import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import {
  introspectRoutes,
  type IntrospectedRoute,
  type OpenApiOperation,
} from "../contract/support/introspect-routes";

/**
 * The upgrade gate, as the document tells it (GAP5-2).
 *
 * MIN_MOBILE_CONTRACT turns app builds below it away with 426
 * CLIENT_UPGRADE_REQUIRED, and the body says what to do next: `minContract`,
 * and `storeUrl` when MOBILE_STORE_URL is set. The gate is a global hook, so
 * no route declared it and /docs never showed it — a client written from the
 * document would read the 426 as an unexplained failure, not as "update the
 * app". Documented on every route behind a session, which is where the app
 * lives, except the ones the gate lets through so a driver can keep and end
 * a session.
 */
const EXEMPT = [
  "POST /user/logout",
  "POST /user/refresh-token",
  "POST /user/session",
  "POST /user/two-factor-verification",
];

type Published = IntrospectedRoute & { operation: OpenApiOperation };

let published: Published[] = [];
let close: () => Promise<void>;

beforeAll(async () => {
  const introspected = await introspectRoutes();

  close = introspected.close;
  published = introspected.routes.filter(
    (route): route is Published =>
      !route.hidden && route.operation !== undefined,
  );
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

describe("426 CLIENT_UPGRADE_REQUIRED in the document", () => {
  const sessionRoutes = () =>
    published.filter(
      (route) =>
        route.onRequest.includes(ensureAuthenticated) &&
        !EXEMPT.includes(route.id),
    );

  it("is on every route behind a session", () => {
    expect(sessionRoutes().length).toBeGreaterThan(200);

    const missing = sessionRoutes()
      .filter((route) => !route.operation.responses["426"])
      .map(({ id }) => id);

    expect(missing).toEqual([]);
  });

  it("says what the body carries: the code, the minimum and the store page", () => {
    const response = sessionRoutes()[0].operation.responses["426"];
    const serialized = JSON.stringify(response);

    expect(serialized).toContain("CLIENT_UPGRADE_REQUIRED");
    expect(serialized).toContain("x-trajetto-client-version");

    const schema = response.content?.["application/json"]?.schema as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;

    expect(Object.keys(schema?.properties ?? {})).toEqual(
      expect.arrayContaining(["code", "message", "minContract", "storeUrl"]),
    );

    // Optional: absent unless MOBILE_STORE_URL is set.
    expect(schema?.required ?? []).not.toContain("storeUrl");
  });

  it("is not on the routes the gate always lets through", () => {
    const documented = published
      .filter((route) => EXEMPT.includes(route.id))
      .filter((route) => route.operation.responses["426"])
      .map(({ id }) => id);

    expect(published.filter((route) => EXEMPT.includes(route.id))).toHaveLength(
      EXEMPT.length,
    );
    expect(documented).toEqual([]);
  });
});

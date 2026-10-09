import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import {
  introspectRoutes,
  type IntrospectedRoute,
  type OpenApiOperation,
} from "./support/introspect-routes";

/**
 * The `X-Client-Sent-At` header, as the document states it (MOB-08).
 *
 * The driver's app stamps each send with it, and the API uses it to move the
 * body's `occurred_at` onto the server's clock. It lived only in prose — the
 * field's description and the departure's summary — so a client generated
 * from /docs never sent it, and its offline facts were dated by a phone
 * clock nobody corrected. Every route whose controller reads it declares it
 * as an optional header parameter, the way Idempotency-Key is declared.
 *
 * No database: building the document needs the router only.
 */
let published: Array<IntrospectedRoute & { operation: OpenApiOperation }> = [];
let close: () => Promise<void>;

beforeAll(async () => {
  const introspected = await introspectRoutes();

  close = introspected.close;

  published = introspected.routes.filter(
    (route): route is IntrospectedRoute & { operation: OpenApiOperation } =>
      !route.hidden && route.operation !== undefined,
  );
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

const headerOf = (route: { operation: OpenApiOperation }) =>
  route.operation.parameters?.find(
    (parameter) =>
      parameter.in === "header" && parameter.name === "x-client-sent-at",
  );

describe("the X-Client-Sent-At header", () => {
  it("is declared on every driver write that reads it", () => {
    const expected = [
      "POST /delivery/arrival/{deliveryId}/business/{businessId}",
      "POST /delivery/proof/{deliveryId}/business/{businessId}",
      "POST /delivery/report-occurrence/{deliveryId}/business/{businessId}",
      "POST /delivery/start-route/{businessId}",
      "POST /route/on-the-way/{stopId}/route/{routeId}/business/{businessId}",
      "POST /route/start-route/{routeId}/business/{businessId}",
      "POST /driver-pause/start/{businessId}",
      "POST /driver-pause/end/{businessId}",
    ];

    const readers = published
      .filter((route) => String(route.handler).includes("CLIENT_SENT_AT_HEADER"))
      .map(({ id }) => id)
      .sort();

    // The list is read from the controllers, so a new reader cannot be
    // forgotten here either.
    expect(readers).toEqual([...expected].sort());

    const missing = published
      .filter((route) => readers.includes(route.id))
      .filter((route) => !headerOf(route)?.description)
      .map(({ id }) => id);

    expect(missing).toEqual([]);
  });

  it("is optional and says what it is for", () => {
    for (const route of published.filter((entry) => headerOf(entry))) {
      const header = headerOf(route)!;

      // Every build before MOB-08 sends no such header.
      expect(header.required ?? false, route.id).toBe(false);
      expect(header.description, route.id).toMatch(/occurred_at/);
    }
  });

  it("keeps the Idempotency-Key the occurrence already declared", () => {
    const occurrence = published.find(
      (route) =>
        route.id ===
        "POST /delivery/report-occurrence/{deliveryId}/business/{businessId}",
    )!;

    expect(
      occurrence.operation.parameters?.some(
        (parameter) =>
          parameter.in === "header" && parameter.name === "idempotency-key",
      ),
    ).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { deliverySchemas } from "@/routes/documentation/delivery-documentation";
import { routeSchemas } from "@/routes/documentation/route-documentation";
import { startDriverRouteSchema } from "@/schemas/start-driver-route-schema";

/**
 * The bodies the driver's app queues from MOB-08 on: every delivery action
 * carries `occurred_at`, the instant of the tap by the phone's clock.
 *
 * Same rules as `mobile-outbox-v1` (see outbox-body-contract.test.ts): the
 * fixtures are append-only, and a failure here is fixed on the server. The
 * extra assertion is that the field SURVIVES parsing — a schema that silently
 * stripped it would accept every body and put the receipt time back on every
 * offline proof.
 */
const FIXTURES = path.join(__dirname, "fixtures", "mobile-outbox-v2");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

describe("what the app queues since it stamps the time of the fact", () => {
  it("an arrival", () => {
    const body = fixture("delivery-arrival");

    expect(deliverySchemas.deliveryArrival.parse(body).occurred_at).toBe(
      body.occurred_at,
    );
  });

  it("a proof of delivery", () => {
    const body = fixture("delivery-proof");

    expect(deliverySchemas.deliveryProof.parse(body).occurred_at).toBe(
      body.occurred_at,
    );
  });

  it("an occurrence", () => {
    const body = fixture("delivery-occurrence");

    expect(deliverySchemas.reportOccurrence.parse(body).occurred_at).toBe(
      body.occurred_at,
    );
  });

  it("a departure, through the route and through the legacy endpoint", () => {
    const body = fixture("delivery-start-route");

    expect(routeSchemas.startRoute.parse(body).occurred_at).toBe(
      body.occurred_at,
    );
    expect(startDriverRouteSchema.parse(body).occurred_at).toBe(
      body.occurred_at,
    );
  });
});

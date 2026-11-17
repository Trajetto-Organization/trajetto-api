import "reflect-metadata";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { env } from "@/env";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

/**
 * The status lines a delivery gets by itself (plano-escala F2-06) start only
 * when DELIVERY_STATUS_TRAIL_ENABLED is on.
 *
 * The image before this release keeps serving during the rolling deploy and
 * after a code rollback, and it reads those lines wrongly: its import undo
 * counts the creation line as work (no delivery of an import is removable
 * any more), its /integration/v1/events names it `delivery.pending` (a topic
 * the catalogue does not have, under a cursor the integrator then moves
 * past), its tower counts the SYSTEM departure line as a manual change (an
 * occurrence that came before can no longer be approved) and its tower feed
 * shows fifty of them per departure. So, off by default: the status moves
 * and the departure tells its webhooks as before, with no new line, until
 * the owner turns it on with nothing older left to serve.
 *
 * The twins are what most tests stand on, so they follow the flag as the
 * repositories do (delivery-status-change-invariant has the Postgres side).
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000000b1";
const DRIVER = "018f0000-0000-7000-8000-0000000000d1";

const original = env.DELIVERY_STATUS_TRAIL_ENABLED;

afterEach(() => {
  env.DELIVERY_STATUS_TRAIL_ENABLED = original;
});

function deliveryData(
  overrides: Partial<CreateDeliveryProps> = {},
): CreateDeliveryProps {
  return {
    recipient_name: "Cliente",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
    businessId: BUSINESS,
    ...overrides,
  } as CreateDeliveryProps;
}

const statusLines = (events: Array<{ type: string }>) =>
  events.filter((event) => event.type === "STATUS_CHANGE");

describe("DELIVERY_STATUS_TRAIL_ENABLED", () => {
  const BASE = {
    NODE_ENV: "development",
    REDIS_URL: "redis://localhost:6379",
    HTTP_REQUEST: "http://localhost:3000",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };

  const parse = (overrides: Record<string, string>) =>
    envSchema.safeParse(definedEnv({ ...BASE, ...overrides }));

  it("is off by default, empty included, and takes only true or false", () => {
    expect(parse({}).data?.DELIVERY_STATUS_TRAIL_ENABLED).toBe(false);
    expect(
      parse({ DELIVERY_STATUS_TRAIL_ENABLED: "" }).data
        ?.DELIVERY_STATUS_TRAIL_ENABLED,
    ).toBe(false);
    expect(
      parse({ DELIVERY_STATUS_TRAIL_ENABLED: "true" }).data
        ?.DELIVERY_STATUS_TRAIL_ENABLED,
    ).toBe(true);
    expect(parse({ DELIVERY_STATUS_TRAIL_ENABLED: "yes" }).success).toBe(false);
  });
});

describe("with the status lines off (the default)", () => {
  beforeEach(() => {
    env.DELIVERY_STATUS_TRAIL_ENABLED = false;
  });

  it("creates a delivery with no line", async () => {
    const deliveries = new InMemoryDeliveryRepository();

    await deliveries.createDelivery(deliveryData());
    await deliveries.createDelivery(deliveryData({ apiKeyId: "key-1" }));

    expect(statusLines(deliveries.events)).toEqual([]);
  });

  it("moves the app's old batch departure and hands it to its webhooks, with no line", async () => {
    const deliveries = new InMemoryDeliveryRepository();
    const loose = await deliveries.createDelivery(
      deliveryData({ driverId: DRIVER }),
    );

    const handed: string[] = [];
    const moved = await deliveries.startDriverRoute(
      BUSINESS,
      DRIVER,
      undefined,
      async (departed) => {
        handed.push(...departed.map((delivery) => delivery.id));
      },
    );

    expect(moved).toBe(1);
    expect(handed).toEqual([loose.id]);
    expect(
      deliveries.deliveries.find((delivery) => delivery.id === loose.id)
        ?.status,
    ).toBe("IN_TRANSIT");
    expect(statusLines(deliveries.events)).toEqual([]);
  });

  it("sends a route's load out, adds to it and brings it back, with no line", async () => {
    const mirror = [
      { id: "d-1", businessId: BUSINESS, status: "PENDING" },
      { id: "d-2", businessId: BUSINESS, status: "PENDING" },
    ];
    const routes = new InMemoryRouteRepository(mirror);

    const route = await routes.createRoute({
      businessId: BUSINESS,
      driverId: DRIVER,
      scheduled_date: new Date(),
      deliveryIds: ["d-1"],
    } as never);

    await routes.transitionRoute(route.id, BUSINESS, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });
    await routes.transitionRoute(route.id, BUSINESS, {
      expectedStatus: "RELEASED",
      status: "IN_PROGRESS",
      started_at: new Date(),
    });
    await routes.addStops(route.id, BUSINESS, ["d-2"]);

    expect(mirror.map((delivery) => delivery.status)).toEqual([
      "IN_TRANSIT",
      "IN_TRANSIT",
    ]);

    await routes.transitionRoute(route.id, BUSINESS, {
      expectedStatus: "IN_PROGRESS",
      status: "CANCELLED",
      cancellation_reason: "Caminhão quebrou",
    });

    expect(mirror.map((delivery) => delivery.status)).toEqual([
      "PENDING",
      "PENDING",
    ]);
    expect(statusLines(routes.events)).toEqual([]);
  });
});

describe("with the status lines on", () => {
  beforeEach(() => {
    env.DELIVERY_STATUS_TRAIL_ENABLED = true;
  });

  it("writes the creation line and the batch departure's", async () => {
    const deliveries = new InMemoryDeliveryRepository();

    await deliveries.createDelivery(deliveryData({ driverId: DRIVER }));
    await deliveries.startDriverRoute(BUSINESS, DRIVER);

    expect(
      statusLines(deliveries.events).map((event) => {
        const line = event as { status_from?: string | null; actor?: string };

        return [line.status_from, line.actor];
      }),
    ).toEqual([
      [null, "USER"],
      ["PENDING", "SYSTEM"],
    ]);
  });
});

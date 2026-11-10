import { afterEach, describe, expect, it } from "vitest";

import { env } from "@/env";

import { GetRouteUseCase } from "@/modules/route/usecases/get-route/get-route-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDriverPositionRepository } from "@/modules/route/repositories/in-memory/in-memory-driver-position-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { GEOCODING_MAX_ATTEMPTS } from "@/shared/delivery/geocoding/geocoding-rules";
import {
  configureGeocodingHold,
  noGeocodingHold,
} from "@/shared/delivery/geocoding/geocoding-hold";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Route, RouteStop } from "@/modules/route/dtos/route-dto";

/**
 * The route detail tells the stop without a point apart (owner's report of
 * 09/11/2026): `address_lookup` SEARCHING while the address is being looked
 * up, NOT_LOCATED once the lookup is over without a point, null with a
 * point, on a server that looks nothing up, while the lookups are held or
 * when nothing asked about the address lately (review of 09/11/2026). The
 * geocoder's bookkeeping and the row's last write are read for it and never
 * answered.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000006b1";
const DISPATCHER = "018f0000-0000-7000-8000-0000000006a1";
const DRIVER = "018f0000-0000-7000-8000-0000000006d1";
const ROUTE = "018f0000-0000-7000-8000-0000000006e1";

const saved = {
  url: env.REVERSE_GEOCODER_URL,
  budget: env.DELIVERY_GEOCODING_DAILY_BUDGET,
};

afterEach(() => {
  env.REVERSE_GEOCODER_URL = saved.url;
  env.DELIVERY_GEOCODING_DAILY_BUDGET = saved.budget;
  configureGeocodingHold(noGeocodingHold);
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const STOPS = {
  pending: {
    geocode_status: null,
    geocode_attempts: 0,
    updated_at: minutesAgo(1),
  },
  // Created an hour ago and never claimed: nothing is coming soon.
  forgotten: {
    geocode_status: null,
    geocode_attempts: 0,
    updated_at: minutesAgo(60),
  },
  retrying: {
    geocode_status: "FAILED",
    geocode_attempts: 2,
    geocode_attempted_at: minutesAgo(1),
  },
  notFound: { geocode_status: "NOT_FOUND", geocode_attempts: 1 },
  coarse: {
    geocode_status: "COARSE",
    geocode_attempts: 1,
    geo_precision: "NEIGHBORHOOD",
  },
  exhausted: {
    geocode_status: "FAILED",
    geocode_attempts: GEOCODING_MAX_ATTEMPTS,
  },
  manual: {
    latitude: -22.5084,
    longitude: -43.1735,
    geo_source: "MANUAL",
    geocode_status: null,
    geocode_attempts: 0,
  },
  // "Fixar no mapa" over a point the geocoder had found on the street.
  pinnedOverFound: {
    latitude: -22.509,
    longitude: -43.174,
    geo_source: "MANUAL",
    geo_precision: "STREET",
    geocode_status: "RESOLVED",
    geocode_attempts: 1,
  },
  found: {
    latitude: -22.5084,
    longitude: -43.1735,
    geo_source: "GEOCODER",
    geo_precision: "STREET",
    geocode_status: "RESOLVED",
    geocode_attempts: 1,
  },
} as const;

function context() {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const drivers = new InMemoryDriverRepository();
  const routes = new InMemoryRouteRepository(
    deliveries.deliveries,
    undefined,
    drivers.drivers,
  );

  users.user.push({
    id: DISPATCHER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);
  drivers.drivers.push({
    id: DRIVER,
    name: "Gabriel",
    status: "ACTIVE",
    businessId: BUSINESS,
  } as Driver);

  routes.routes.push({
    id: ROUTE,
    code: 3,
    status: "PLANNED",
    driverId: DRIVER,
    vehicleId: null,
    businessId: BUSINESS,
    plan_version: 1,
    scheduled_date: new Date("2026-11-09"),
  } as Route);

  Object.entries(STOPS).forEach(([id, columns], index) => {
    (deliveries.deliveries as unknown as Array<Record<string, unknown>>).push({
      id,
      businessId: BUSINESS,
      status: "PENDING",
      recipient_name: id,
      latitude: null,
      longitude: null,
      geo_source: null,
      ...columns,
    });
    routes.stops.push({
      id: `stop-${id}`,
      routeId: ROUTE,
      deliveryId: id,
      sequence: (index + 1) * 10,
      status: "PENDING",
    } as RouteStop);
  });

  return new GetRouteUseCase(
    routes,
    users,
    new InMemoryDriverPositionRepository(),
    new InMemoryBusinessRepository(),
    new InMemoryVehicleChecklistRepository(),
    new InMemoryFuelRepository(),
  );
}

async function lookups() {
  const { route } = await context().execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    routeId: ROUTE,
  });

  return {
    route,
    byId: Object.fromEntries(
      route.stops.map((stop) => [
        stop.delivery.id,
        stop.delivery.address_lookup,
      ]),
    ),
  };
}

describe("get-route's address_lookup", () => {
  it("says whether each stop without a point is being looked up or was not found", async () => {
    env.REVERSE_GEOCODER_URL = "https://geocoder.example/v1";
    env.DELIVERY_GEOCODING_DAILY_BUDGET = 100;

    const { byId } = await lookups();

    expect(byId).toEqual({
      pending: "SEARCHING",
      forgotten: null,
      retrying: null,
      notFound: "NOT_LOCATED",
      coarse: "NOT_LOCATED",
      exhausted: "NOT_LOCATED",
      manual: null,
      pinnedOverFound: null,
      found: null,
    });
  });

  it("promises nothing while the lookups are held", async () => {
    env.REVERSE_GEOCODER_URL = "https://geocoder.example/v1";
    env.DELIVERY_GEOCODING_DAILY_BUDGET = 100;

    let asked = 0;

    configureGeocodingHold({
      held: async () => {
        asked += 1;

        return true;
      },
    });

    const { byId } = await lookups();

    expect(byId.pending).toBeNull();
    expect(byId.notFound).toBe("NOT_LOCATED");
    expect(asked).toBe(1);
  });

  it("asks Redis nothing about the hold on a server that looks nothing up", async () => {
    env.REVERSE_GEOCODER_URL = undefined;

    let asked = 0;

    configureGeocodingHold({
      held: async () => {
        asked += 1;

        return true;
      },
    });

    await lookups();

    expect(asked).toBe(0);
  });

  it("answers the level, never the job's bookkeeping", async () => {
    env.REVERSE_GEOCODER_URL = "https://geocoder.example/v1";
    env.DELIVERY_GEOCODING_DAILY_BUDGET = 100;

    const { route } = await lookups();

    for (const stop of route.stops) {
      expect(stop.delivery).not.toHaveProperty("geocode_status");
      expect(stop.delivery).not.toHaveProperty("geocode_attempts");
      expect(stop.delivery).not.toHaveProperty("geocode_attempted_at");
      expect(stop.delivery).not.toHaveProperty("updated_at");
    }

    const precisionOf = (id: string) =>
      route.stops.find((stop) => stop.delivery.id === id)?.delivery
        .geo_precision;

    expect(precisionOf("found")).toBe("STREET");
    expect(precisionOf("coarse")).toBe("NEIGHBORHOOD");

    // A pin made by hand is exact, whatever the geocoder wrote before it.
    expect(precisionOf("pinnedOverFound")).toBeNull();
    expect(precisionOf("manual")).toBeNull();
  });

  it("says nothing on a server that looks nothing up", async () => {
    env.REVERSE_GEOCODER_URL = undefined;

    const { byId } = await lookups();

    expect(Object.values(byId).every((state) => state === null)).toBe(true);
  });
});

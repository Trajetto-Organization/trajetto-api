import http from "k6/http";
import { check } from "k6";

import { Trend, Rate } from "k6/metrics";

/**
 * The shared request vocabulary of every scenario.
 *
 * One module and not one per script, because the thing being measured has to
 * be the same across smoke, load, stress and soak — otherwise "the p95 doubled
 * under stress" might just mean the stress script asked for something else.
 */
const context = JSON.parse(open("../fixtures/load-context.json"));

const BASE = __ENV.LOAD_BASE_URL || context.baseUrl;

/**
 * Per-surface latency, tagged.
 *
 * The aggregate p95 of a run is close to meaningless here: the position ingest
 * is a bulk insert and the control tower is five aggregates, and averaging
 * them hides whichever one is slow behind whichever one is fast.
 */
const latency = new Trend("surface_latency", true);
const failures = new Rate("surface_failures");

function record(surface, response, expected) {
  latency.add(response.timings.duration, { surface });

  const ok = check(
    response,
    {
      [`${surface}: status`]: (r) => expected.includes(r.status),
    },
    { surface },
  );

  failures.add(!ok, { surface });

  return ok;
}

/**
 * A different dispatcher per virtual user.
 *
 * The rate limiter keys on the user, so one token for the whole run measures
 * the limiter rather than the server: the first version of this file sent
 * everything as one manager and reported 55% failures at a p95 of 14ms — a
 * machine sitting idle while the test called it overloaded.
 */
function managerHeaders() {
  const tokens = context.managerTokens;

  return {
    Authorization: `Bearer ${tokens[__VU % tokens.length]}`,
    "Content-Type": "application/json",
  };
}

function driverHeaders(index) {
  const token = context.driverTokens[index % context.driverTokens.length];

  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function apiKeyHeaders() {
  return {
    Authorization: `Bearer ${context.apiKey}`,
    "Content-Type": "application/json",
  };
}

const pick = (values) => values[Math.floor(Math.random() * values.length)];

// --------------------------------------------------------------- surfaces
const surfaces = {
  /** The dispatcher's board. The single most-opened screen in the product. */
  listDeliveries() {
    const response = http.get(
      `${BASE}/delivery/list-delivery?page=1&pageSize=20&businessId=${context.businessId}`,
      { headers: managerHeaders(), tags: { surface: "delivery.list" } },
    );

    return record("delivery.list", response, [200]);
  },

  /** One document, opened from the board. */
  getDelivery() {
    const id = pick(context.deliveryIds);

    const response = http.get(
      `${BASE}/delivery/get-delivery/${id}/business/${context.businessId}`,
      { headers: managerHeaders(), tags: { surface: "delivery.get" } },
    );

    return record("delivery.get", response, [200, 404]);
  },

  listRoutes() {
    const response = http.get(
      `${BASE}/route/list-routes?page=1&pageSize=20&businessId=${context.businessId}`,
      { headers: managerHeaders(), tags: { surface: "route.list" } },
    );

    return record("route.list", response, [200]);
  },

  /** The monitoring panel's numbers. */
  operationSummary() {
    const response = http.get(
      `${BASE}/delivery/operation-summary?businessId=${context.businessId}`,
      { headers: managerHeaders(), tags: { surface: "delivery.summary" } },
    );

    return record("delivery.summary", response, [200]);
  },

  /** The control tower: five aggregates and a position query, in one call. */
  controlTower() {
    const response = http.get(
      `${BASE}/route/control-tower?businessId=${context.businessId}`,
      { headers: managerHeaders(), tags: { surface: "route.tower" } },
    );

    return record("route.tower", response, [200]);
  },

  /**
   * The heaviest write on the platform.
   *
   * At the reference scale: twenty thousand drivers pinging every thirty
   * seconds is ~670 inserts a second, and each request carries a small batch.
   */
  recordPositions(vu) {
    const now = Date.now();

    const pings = Array.from({ length: 4 }, (_, index) => ({
      latitude: -23.55 + (vu % 100) * 0.001 + index * 0.0002,
      longitude: -46.63 + (vu % 100) * 0.001 + index * 0.0002,
      accuracy: 12,
      speed: 40,
      heading: 90,
      recorded_at: new Date(now - (4 - index) * 15000).toISOString(),
    }));

    const response = http.post(
      `${BASE}/route/positions`,
      JSON.stringify({ pings }),
      { headers: driverHeaders(vu), tags: { surface: "route.positions" } },
    );

    // 429 is a pass, not a failure: the route declares a limit and the point
    // of the run is to find where the limit bites, not to pretend it is absent.
    return record("route.positions", response, [200, 429]);
  },

  /** The driver's working list, offline-first — one payload per app open. */
  myDeliveries(vu) {
    const response = http.get(
      `${BASE}/delivery/my-deliveries/${context.businessId}`,
      { headers: driverHeaders(vu), tags: { surface: "delivery.mine" } },
    );

    return record("delivery.mine", response, [200]);
  },

  /** The public API, as a customer's ERP walks it. */
  integrationDeliveries() {
    const response = http.get(
      `${BASE}/integration/v1/deliveries?limit=50`,
      { headers: apiKeyHeaders(), tags: { surface: "integration.deliveries" } },
    );

    return record("integration.deliveries", response, [200, 429]);
  },

  /** Open, cached, and the first thing anybody integrating hits. */
  catalogue() {
    const response = http.get(`${BASE}/integration/v1/catalogue`, {
      tags: { surface: "integration.catalogue" },
    });

    return record("integration.catalogue", response, [200, 429]);
  },

  /** The bell's counter — polled by every open tab in the company. */
  unreadCount() {
    const response = http.get(`${BASE}/notification/unread-count`, {
      headers: managerHeaders(),
      tags: { surface: "notification.unread" },
    });

    return record("notification.unread", response, [200]);
  },

  /** The management dashboard's cards. */
  dashboardOverview() {
    const response = http.get(
      `${BASE}/dashboard/overview?businessId=${context.businessId}`,
      { headers: managerHeaders(), tags: { surface: "dashboard.overview" } },
    );

    return record("dashboard.overview", response, [200]);
  },

  health() {
    const response = http.get(`${BASE}/health`, {
      tags: { surface: "system.health" },
    });

    return record("system.health", response, [200]);
  },
};

export { BASE, context, surfaces };

import http from "k6/http";
import { check } from "k6";

import exec from "k6/execution";

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

/**
 * How often the server said "slow down" rather than answering.
 *
 * Three surfaces accept a 429 as a correct response, because it IS one: the
 * position ingest and the public API both carry their own ceilings and
 * refusing past them is the behaviour under test. But a request that was
 * turned away at the limiter never reached the code the run is measuring, and
 * counting it as a success makes a run where a third of the load bounced look
 * exactly like a run where none of it did. Thresholded, so that stays visible.
 */
const throttled = new Rate("surface_throttled");

/**
 * Which part of the run a measurement belongs to.
 *
 * A soak exists to find what only shows up after hours — a connection opened
 * per request and never closed, a map that only grows. All of those look like
 * latency that CLIMBS, and a p95 over the whole run hides a climb behind a
 * healthy start: thirty minutes at 25 ms and five at 200 ms still averages
 * fine. Tagging the last fifth separately is what lets a threshold ask the
 * question the soak is actually for.
 *
 * `currentTestRunDuration` is wall-clock since the run began, the same for
 * every virtual user — a per-VU timer would not be, because VUs start at
 * different moments.
 */
const LATE_FRACTION = 0.8;

function phaseOf() {
  const total = exec.instance.currentTestRunDuration;
  const planned = Number(__ENV.RUN_DURATION_MS || 0);

  if (!planned) return "all";

  return total >= planned * LATE_FRACTION ? "late" : "early";
}

function record(surface, response, expected) {
  const phase = phaseOf();

  latency.add(response.timings.duration, { surface, phase });

  const ok = check(
    response,
    {
      [`${surface}: status`]: (r) => expected.includes(r.status),
    },
    { surface },
  );

  failures.add(!ok, { surface, phase });
  throttled.add(response.status === 429, { surface });

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

  /**
   * The dispatcher's chat list.
   *
   * Left open all day beside the board, and it is the heaviest READ the chat
   * has: one row per conversation with the last message, the unread count and
   * the delivery behind it. It was absent from every load scenario — so the
   * one surface where a carrier's whole office sits idle-but-connected never
   * appeared in a measurement.
   */
  chatThreads() {
    const response = http.get(
      `${BASE}/chat/list-threads?page=1&pageSize=20&businessId=${context.businessId}`,
      { headers: managerHeaders(), tags: { surface: "chat.threads" } },
    );

    return record("chat.threads", response, [200]);
  },

  /** A conversation opened: the messages page the panel loads first. */
  chatMessages(vu) {
    const driverId = context.driverIds[vu % context.driverIds.length];

    const response = http.get(
      `${BASE}/chat/list-messages?page=1&pageSize=30&businessId=${context.businessId}&driverId=${driverId}`,
      { headers: managerHeaders(), tags: { surface: "chat.messages" } },
    );

    // 404 is a correct answer for a driver with no conversation yet, and the
    // seed does not create one for every driver.
    return record("chat.messages", response, [200, 404]);
  },

  health() {
    const response = http.get(`${BASE}/health`, {
      tags: { surface: "system.health" },
    });

    return record("system.health", response, [200]);
  },
};

export { BASE, context, surfaces };

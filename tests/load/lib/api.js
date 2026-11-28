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
 * How often the server shed the request: a 503 that says when to come back
 * (Retry-After). Under load shedding in enforce (plano-escala F2-24) that is
 * the API refusing work it cannot do in time, the answer the spike's
 * acceptance asks for; a 503 without the header is a failure.
 */
const shed = new Rate("surface_shed");

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

/**
 * How long the run is planned to last, set by the scenario that thresholds on
 * `phase` (soak.js, from its own duration). It used to come only from
 * RUN_DURATION_MS: without that variable every sample was tagged `all`, and
 * the `{phase:late}` thresholds had nothing to judge — they passed empty.
 */
let plannedMs = Number(__ENV.RUN_DURATION_MS || 0);

function planRun(ms) {
  if (!Number(__ENV.RUN_DURATION_MS || 0)) plannedMs = ms;
}

function phaseOf() {
  const total = exec.instance.currentTestRunDuration;

  if (!plannedMs) return "all";

  return total >= plannedMs * LATE_FRACTION ? "late" : "early";
}

/** Whether the answer says when to come back. */
function retryAfterOf(response) {
  const headers = response?.headers ?? {};
  const value = headers["Retry-After"] ?? headers["retry-after"];
  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * One answer, measured.
 *
 * A 429 or a 503 that carries Retry-After is a refusal the server meant
 * (the limiter, the panel budget, load shedding): it counts in
 * `surface_throttled` or `surface_shed`, never in `surface_failures`, on
 * every surface. It used to be a failure everywhere but the three surfaces
 * that listed 429, so load shedding doing its job (plano-escala F2-24)
 * would have read as the product breaking. The ceilings on throttled and
 * shed stay in the scenes, because a flood of refusals IS worth knowing.
 *
 * `tags` adds the scene's own dimensions (a tenant's class, a stage of the
 * run) to every sample.
 */
function record(surface, response, expected, tags = {}) {
  const phase = phaseOf();
  const sampleTags = { surface, phase, ...tags };

  latency.add(response.timings.duration, sampleTags);

  const refused =
    (response.status === 429 || response.status === 503) &&
    retryAfterOf(response) !== null;

  const ok = check(
    response,
    {
      [`${surface}: status`]: (r) => expected.includes(r.status) || refused,
    },
    { surface },
  );

  failures.add(!ok, sampleTags);
  throttled.add(response.status === 429, { surface, ...tags });
  shed.add(response.status === 503 && refused, { surface, ...tags });

  return ok;
}

/** A key per request, for the routes that take an Idempotency-Key. */
function idempotencyKey(prefix) {
  return `${prefix}-${__VU}-${__ITER}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** The business day as the API keys it (YYYY-MM-DD), on the São Paulo clock. */
function businessDay() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The header every build of the driver's app sends; `contract` is what the
 * positions' load shedding counts (F2-25).
 */
function appHeaders(token, contract) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "x-trajetto-client": "mobile",
    "x-trajetto-client-version": `platform=android; version=load; contract=${contract}; outbox=1`,
  };
}

/** `count` points ending now, one per 15 s, as the app records them. */
function pingsEndingNow(count, seed) {
  const now = Date.now();

  return Array.from({ length: count }, (_, index) => ({
    latitude: -23.55 + (seed % 100) * 0.001 + index * 0.00002,
    longitude: -46.63 + (seed % 100) * 0.001 + index * 0.00002,
    accuracy: 12,
    speed: 40,
    heading: 90,
    recorded_at: new Date(now - (count - index) * 15000).toISOString(),
  }));
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
   * At the 5M step the ruler is ~333 POST/s, each carrying a small batch:
   * ~1,333 points a second (an estimate, the scale plan's decision D11; see
   * lib/mix.js).
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

  /**
   * One phone's flush, as the app sends it (positions.js, outage.js): its
   * own driver's token, the contract it runs, `count` points. The response
   * is returned, so the caller can honour `nextFlushAfterMs` and
   * Retry-After the way that contract does.
   */
  flushPositions(driverIndex, contract, count, tags = {}, base = BASE) {
    const token =
      context.driverTokens[driverIndex % context.driverTokens.length];

    const response = http.post(
      `${base}/route/positions`,
      JSON.stringify({ pings: pingsEndingNow(count, driverIndex) }),
      {
        headers: appHeaders(token, contract),
        tags: { surface: "route.positions" },
        timeout: "30s",
      },
    );

    record("route.positions", response, [200], tags);

    return response;
  },

  /**
   * A delivery created by hand on the panel (write-mix.js): the board's
   * own write, with the shipper the seed created.
   */
  createDelivery() {
    const response = http.post(
      `${BASE}/delivery/create-delivery/${context.businessId}`,
      JSON.stringify({
        shipperId: context.shipperId,
        recipient_name: `Cliente da carga ${__VU}-${__ITER}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua da Carga",
        address_number: String(__ITER % 1000),
        scheduled_date: businessDay(),
      }),
      {
        headers: {
          ...managerHeaders(),
          "Idempotency-Key": idempotencyKey("delivery"),
        },
        tags: { surface: "delivery.create" },
      },
    );

    return record("delivery.create", response, [201]);
  },

  /** A proof photo's presigned PUT, asked by the phone (signed locally). */
  presignUpload(vu) {
    const response = http.post(
      `${BASE}/uploads/presign/${context.businessId}`,
      JSON.stringify({
        uploadType: "deliveryPhotos",
        files: [
          {
            originalFilename: "canhoto.jpg",
            contentType: "image/jpeg",
            size: 350000,
          },
        ],
      }),
      { headers: driverHeaders(vu), tags: { surface: "upload.presign" } },
    );

    return record("upload.presign", response, [201]);
  },

  /** The office writing to one driver (the chat's commonest write). */
  sendChat(vu) {
    const driverId = context.driverIds[vu % context.driverIds.length];

    const response = http.post(
      `${BASE}/chat/send-message`,
      JSON.stringify({
        driverIds: [driverId],
        kind: "TEXT",
        body: `Mensagem da carga ${__VU}-${__ITER}`,
      }),
      {
        headers: {
          ...managerHeaders(),
          "Idempotency-Key": idempotencyKey("chat"),
        },
        tags: { surface: "chat.send" },
      },
    );

    return record("chat.send", response, [201]);
  },

  /**
   * The bell's NDJSON list, as every open tab reads it at its tick. The
   * response is returned (tower.js honours its Retry-After).
   */
  notificationStream(token = null, tags = {}) {
    const response = http.get(`${BASE}/notification/stream?limit=50`, {
      headers: token ? { Authorization: `Bearer ${token}` } : managerHeaders(),
      tags: { surface: "notification.stream" },
    });

    record("notification.stream", response, [200], tags);

    return response;
  },

  /**
   * One session's refresh (write-mix.js): the token rotates, so the caller
   * keeps the one this returns; a session is never shared between VUs, or
   * the reuse detection would end it.
   */
  refreshSession(refreshToken) {
    const response = http.post(
      `${BASE}/user/refresh-token`,
      JSON.stringify({ token: refreshToken }),
      {
        headers: { "Content-Type": "application/json" },
        tags: { surface: "user.refresh" },
      },
    );

    record("user.refresh", response, [200]);

    if (response.status !== 200) return refreshToken;

    try {
      return response.json("refresh_token") || refreshToken;
    } catch {
      return refreshToken;
    }
  },

  /**
   * The tower of ANY company, with that company's own session (tower.js,
   * noisy-tenant.js). One function per surface, each with its own record,
   * so the harness test reads which surface a scene runs.
   */
  tenantTower(businessId, token, tags = {}) {
    const response = http.get(
      `${BASE}/route/control-tower?businessId=${businessId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        tags: { surface: "route.tower" },
      },
    );

    record("route.tower", response, [200], tags);

    return response;
  },

  /** The board of ANY company, without a period (the panel budget's 10). */
  tenantDeliveries(businessId, token, tags = {}) {
    const response = http.get(
      `${BASE}/delivery/list-delivery?page=1&pageSize=20&businessId=${businessId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        tags: { surface: "delivery.list" },
      },
    );

    record("delivery.list", response, [200], tags);

    return response;
  },

  /** The route list of ANY company. */
  tenantRoutes(businessId, token, tags = {}) {
    const response = http.get(
      `${BASE}/route/list-routes?page=1&pageSize=20&businessId=${businessId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        tags: { surface: "route.list" },
      },
    );

    record("route.list", response, [200], tags);

    return response;
  },

  /**
   * A spreadsheet upload (plano-escala LOAD-04): the 202 with the import's
   * id; the rows are processed after the answer, one import at a time per
   * replica. 429 IMPORT_BUSY with Retry-After is the queue being full.
   */
  importSpreadsheet(file, token, tags = {}) {
    const response = http.post(
      `${BASE}/import/import-spreadsheet/${context.businessId}`,
      JSON.stringify({
        filename: file.filename,
        content: file.content,
        shipperId: context.shipperId,
      }),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        tags: { surface: "import.spreadsheet" },
        timeout: "120s",
      },
    );

    record("import.spreadsheet", response, [202], tags);

    return response;
  },

  /** An import's status and counters, polled until it leaves IN_PROGRESS. */
  getImport(importId, token, tags = {}) {
    const response = http.get(
      `${BASE}/import/get-import/${importId}/business/${context.businessId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        tags: { surface: "import.get" },
      },
    );

    record("import.get", response, [200], tags);

    return response;
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
    const response = http.get(`${BASE}/integration/v1/deliveries?limit=50`, {
      headers: apiKeyHeaders(),
      tags: { surface: "integration.deliveries" },
    });

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

/**
 * A threshold that always holds, one per surface and metric.
 *
 * k6 only breaks a tagged metric out in its summary when some threshold names
 * that tag, so a run reported a per-surface p95 for the four thresholded
 * surfaces and an aggregate for everything else — the aggregate this file's
 * own header calls close to meaningless. These name every surface, so the
 * summary (and --summary-export) carries each one; they never fail a run.
 */
const SURFACE_NAMES = [
  "delivery.list",
  "delivery.get",
  "delivery.summary",
  "delivery.mine",
  "route.list",
  "route.tower",
  "route.positions",
  "integration.deliveries",
  "integration.catalogue",
  "notification.unread",
  "dashboard.overview",
  "chat.threads",
  "chat.messages",
  "system.health",
  "delivery.create",
  "upload.presign",
  "chat.send",
  "notification.stream",
  "user.refresh",
];

function perSurfaceBreakdown() {
  const thresholds = {};

  for (const surface of SURFACE_NAMES) {
    thresholds[`surface_latency{surface:${surface}}`] = ["max>=0"];
    thresholds[`surface_failures{surface:${surface}}`] = ["rate>=0"];
    thresholds[`surface_throttled{surface:${surface}}`] = ["rate>=0"];
    thresholds[`surface_shed{surface:${surface}}`] = ["rate>=0"];
  }

  return thresholds;
}

/**
 * The same always-holding thresholds for a scene's own tags, so the
 * summary-export carries the numbers its acceptance compares
 * (lib/verdicts.mjs): `breakdownOf("class", ["noisy", "normal"])`, or with
 * a second tag for each pair of values.
 */
function breakdownOf(tag, values, otherTag = null, otherValues = []) {
  const thresholds = {};
  const keys = otherTag
    ? values.flatMap((value) =>
        otherValues.map((other) => `${tag}:${value},${otherTag}:${other}`),
      )
    : values.map((value) => `${tag}:${value}`);

  for (const key of keys) {
    thresholds[`surface_latency{${key}}`] = ["max>=0"];
    thresholds[`surface_failures{${key}}`] = ["rate>=0"];
    thresholds[`surface_throttled{${key}}`] = ["rate>=0"];
    thresholds[`surface_shed{${key}}`] = ["rate>=0"];
  }

  return thresholds;
}

/** p50/p95/p99 in every scene's summary and summary-export. */
const SUMMARY_TREND_STATS = [
  "avg",
  "min",
  "med",
  "max",
  "p(90)",
  "p(95)",
  "p(99)",
  "count",
];

export {
  BASE,
  SUMMARY_TREND_STATS,
  breakdownOf,
  context,
  perSurfaceBreakdown,
  planRun,
  retryAfterOf,
  surfaces,
};

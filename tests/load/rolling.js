import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";

/**
 * A rolling deploy under steady load, judged by one number: 5xx responses.
 *
 * Plano-escala LOAD-06. Production replaces a replica by starting the new
 * one, waiting for its healthcheck, taking the old one out of the service's
 * virtual address and only then sending it SIGTERM (start-first). The old
 * one still owns the keep-alive connections Traefik opened to it; if it
 * closes one while Traefik writes a request on it, the client gets a 502
 * that Go does not retry for a POST. The drain answers with
 * `Connection: close` (F1-15) and the deadlines fit the grace (F1-14), so
 * the expected count is ZERO — not "low". A threshold of 0.1% would pass
 * the very race this file exists to catch.
 *
 * Self-contained on purpose (no ./lib import): it runs as `k6 run -` from
 * stdin, on the local rehearsal (tests/load/swarm-rolling.sh) and on the
 * staging host (tests/load/staging-burn-in.sh, LOAD-09), where the
 * repository is not checked out.
 *
 * Environment:
 *   ROLLING_BASE_URL      the edge, e.g. http://<prefix>-edge (required)
 *   ROLLING_CONTEXT_JSON  {"businessId", "managerTokens", "driverTokens"}:
 *                         tests/load/seed.ts locally, staging-fixture.mjs on
 *                         staging (required; passed through the environment,
 *                         never on a command line)
 *   ROLLING_RATE          requests per second (default 50; the burn-in caps
 *                         it at 30)
 *   ROLLING_DURATION      k6 duration (default 5m)
 *   ROLLING_MAX_VUS       ceiling of virtual users, so of sockets (default
 *                         100; the burn-in caps it at 200)
 *   ROLLING_HOST          Host header to send, when the URL's host is not
 *                         the router's (optional)
 */
const BASE = (__ENV.ROLLING_BASE_URL || "").replace(/\/+$/, "");
const RATE = Number(__ENV.ROLLING_RATE || 50);
const DURATION = __ENV.ROLLING_DURATION || "5m";
const MAX_VUS = Number(__ENV.ROLLING_MAX_VUS || 100);
const HOST = __ENV.ROLLING_HOST || "";

function readContext() {
  let context;

  try {
    context = JSON.parse(__ENV.ROLLING_CONTEXT_JSON || "");
  } catch {
    throw new Error(
      "ROLLING_CONTEXT_JSON ausente ou inválido: rode o seed (local) ou o staging-fixture.mjs (staging) antes.",
    );
  }

  const tokens = (list) =>
    Array.isArray(list) && list.length > 0 && list.every((t) => !!t);

  if (
    !context.businessId ||
    !tokens(context.managerTokens) ||
    !tokens(context.driverTokens)
  ) {
    throw new Error(
      "ROLLING_CONTEXT_JSON precisa de businessId, managerTokens e driverTokens.",
    );
  }

  return context;
}

if (!BASE) throw new Error("ROLLING_BASE_URL é obrigatório.");
if (!Number.isFinite(RATE) || RATE <= 0) {
  throw new Error(`ROLLING_RATE inválido: ${__ENV.ROLLING_RATE}`);
}

const context = readContext();

export const options = {
  scenarios: {
    rolling: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      // A request takes milliseconds; the headroom is for the seconds a
      // replica spends starting while the others absorb its share.
      preAllocatedVUs: Math.min(MAX_VUS, Math.max(10, Math.ceil(RATE / 2))),
      maxVUs: MAX_VUS,
    },
  },

  thresholds: {
    // The verdict. Zero, not a rate.
    rolling_5xx: ["count==0"],
    // No response at all (reset, refused, timeout) is the same failure seen
    // from the client, one layer down.
    rolling_transport_errors: ["count==0"],
    // A 401 from an expired token or a 404 from a wrong id means the run
    // measured the fixture, not the deploy: smoke.js's lesson.
    rolling_unexpected: ["rate<0.01"],
  },

  summaryTrendStats: ["avg", "p(95)", "p(99)", "max"],
};

const fivexx = new Counter("rolling_5xx");
const transport = new Counter("rolling_transport_errors");
const unexpected = new Rate("rolling_unexpected");
const throttled = new Rate("rolling_throttled");

const pick = (list, index) => list[index % list.length];

function headers(token) {
  const result = { "Content-Type": "application/json" };

  if (token) result.Authorization = `Bearer ${token}`;
  if (HOST) result.Host = HOST;

  return result;
}

function judge(surface, response, expected) {
  const status = response.status;

  if (status === 0) transport.add(1, { surface });
  if (status >= 500) fivexx.add(1, { surface, status: String(status) });

  const ok = expected.includes(status);

  unexpected.add(!ok && status !== 0 && status < 500, { surface });
  throttled.add(status === 429, { surface });
  check(response, { [`${surface}: status`]: () => ok }, { surface });
}

const params = (surface, token) => ({
  headers: headers(token),
  tags: { surface },
  timeout: "30s",
});

/**
 * Driver-heavy, like the platform: the position ingest is a third of the
 * real mix and the heaviest write (lib/mix.js). Manager reads stay at 15%
 * so a single administrator token on staging stays under the 300/min per
 * user at the burn-in's 30 req/s.
 */
const MIX = [
  {
    weight: 50,
    run(iteration) {
      const now = Date.now();
      const pings = Array.from({ length: 4 }, (_, index) => ({
        latitude: -23.55 + (iteration % 100) * 0.0001 + index * 0.0002,
        longitude: -46.63 + (iteration % 100) * 0.0001 + index * 0.0002,
        accuracy: 12,
        speed: 40,
        heading: 90,
        recorded_at: new Date(now - (4 - index) * 15000).toISOString(),
      }));

      const response = http.post(
        `${BASE}/route/positions`,
        JSON.stringify({ pings }),
        params("route.positions", pick(context.driverTokens, iteration)),
      );

      // 429 is the route's own ceiling (120/min per driver): an answer.
      judge("route.positions", response, [200, 429]);
    },
  },
  {
    weight: 30,
    run(iteration) {
      const response = http.get(
        `${BASE}/delivery/my-deliveries/${context.businessId}`,
        params("delivery.mine", pick(context.driverTokens, iteration)),
      );

      judge("delivery.mine", response, [200, 429]);
    },
  },
  {
    weight: 10,
    run(iteration) {
      const response = http.get(
        `${BASE}/notification/unread-count`,
        params("notification.unread", pick(context.managerTokens, iteration)),
      );

      judge("notification.unread", response, [200, 429]);
    },
  },
  {
    weight: 5,
    run(iteration) {
      const response = http.get(
        `${BASE}/route/list-routes?page=1&pageSize=20&businessId=${context.businessId}`,
        params("route.list", pick(context.managerTokens, iteration)),
      );

      judge("route.list", response, [200, 429]);
    },
  },
  {
    weight: 5,
    run() {
      const response = http.get(
        `${BASE}/health/liveness`,
        params("system.liveness"),
      );

      judge("system.liveness", response, [200]);
    },
  },
];

const TOTAL = MIX.reduce((sum, entry) => sum + entry.weight, 0);

export default function rolling() {
  const iteration = Math.floor(Math.random() * 1_000_000);
  let ticket = Math.random() * TOTAL;

  for (const entry of MIX) {
    ticket -= entry.weight;

    if (ticket < 0) {
      entry.run(iteration);
      return;
    }
  }

  MIX[0].run(iteration);
}

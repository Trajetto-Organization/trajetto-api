import exec from "k6/execution";

import {
  SUMMARY_TREND_STATS,
  breakdownOf,
  context,
  surfaces,
} from "./lib/api.js";
import { parseDuration } from "./lib/duration.js";

/**
 * One company at ten times the rate, beside twenty normal ones
 * (plano-escala LOAD-03; the acceptance of F2-28, the panel budget per
 * company).
 *
 * Thousands of carriers share one database and one pool. A company whose
 * office opens twenty towers and a few exports at once used to spend the
 * pool the others waited on, and the others saw it as a slow product. The
 * question is the other companies' p95: first the normals alone
 * (`stage:baseline`), then with the noisy one beside them (`stage:noisy`).
 * The acceptance (lib/verdicts.mjs, noisyTenantVerdict): the normals' p95
 * moves at most 10%, none of their reads fails, and with
 * TENANT_PANEL_BUDGET_MODE=enforce the noisy one is answered 429
 * TENANT_BUSY. In observe (the default) the budget only counts, and the
 * scene measures what the isolation would have to fix.
 *
 * The noisy company is the fixture's primary (50 sessions); the normals are
 * the seed's panelTenants (LOAD_PANEL_TENANTS ≥ NOISY_NORMALS). Each read is
 * the tower, the board or the route list in turn: costs 3, 10 and 10 in the
 * panel budget (lists without a period).
 *
 *   NOISY_NORMALS      normal companies (20)
 *   NOISY_TENANT_RATE  reads a second of each normal company (3)
 *   NOISY_FACTOR       how many times that the noisy one reads (10)
 *   NOISY_BASELINE     the normals alone (3m)
 *   NOISY_DURATION     then with the noisy one (3m)
 */
const NORMALS = (context.panelTenants || []).slice(
  0,
  Number(__ENV.NOISY_NORMALS || 20),
);

const RATE = Number(__ENV.NOISY_TENANT_RATE || 3);
const FACTOR = Number(__ENV.NOISY_FACTOR || 10);

const BASELINE = __ENV.NOISY_BASELINE || "3m";
const NOISE = __ENV.NOISY_DURATION || "3m";

const BASELINE_MS = parseDuration(BASELINE);
const NOISE_MS = parseDuration(NOISE);

/** The tower, the board, the route list: 3, 10 and 10 in the budget. */
const READS = 3;

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,

  scenarios: {
    normals: {
      executor: "constant-arrival-rate",
      exec: "normal",
      rate: Math.max(1, RATE * NORMALS.length),
      timeUnit: "1s",
      duration: `${BASELINE_MS + NOISE_MS}ms`,
      preAllocatedVUs: Math.max(10, RATE * NORMALS.length),
      maxVUs: Math.max(50, RATE * NORMALS.length * 5),
    },

    noisy: {
      executor: "constant-arrival-rate",
      exec: "noisy",
      startTime: `${BASELINE_MS}ms`,
      rate: Math.max(1, RATE * FACTOR),
      timeUnit: "1s",
      duration: `${NOISE_MS}ms`,
      preAllocatedVUs: Math.max(10, RATE * FACTOR),
      maxVUs: Math.max(50, RATE * FACTOR * 5),
    },
  },

  thresholds: {
    // What the verdict compares: the normals before and during the noise,
    // and each class on its own.
    ...breakdownOf("class", ["normal", "noisy"], "stage", [
      "baseline",
      "noisy",
    ]),
    ...breakdownOf("class", ["normal", "noisy"]),

    // A normal company's read never fails because of somebody else.
    "surface_failures{class:normal}": ["rate<0.01"],

    "surface_latency{surface:route.tower}": ["max>=0"],
    "surface_latency{surface:delivery.list}": ["max>=0"],
    "surface_latency{surface:route.list}": ["max>=0"],
  },
};

export function setup() {
  if (NORMALS.length === 0) {
    throw new Error(
      "noisy-tenant.js: o fixture não tem panelTenants. Semeie com LOAD_PANEL_TENANTS=20 (seed.ts).",
    );
  }
}

/** Which stage of the run a sample belongs to, by the run's clock. */
function stageOf() {
  return exec.instance.currentTestRunDuration < BASELINE_MS
    ? "baseline"
    : "noisy";
}

function read(kind, businessId, token, tags) {
  if (kind === 0) surfaces.tenantTower(businessId, token, tags);
  else if (kind === 1) surfaces.tenantDeliveries(businessId, token, tags);
  else surfaces.tenantRoutes(businessId, token, tags);
}

export function normal() {
  const iteration = exec.scenario.iterationInTest;
  const tenant = NORMALS[iteration % NORMALS.length];

  read(
    Math.floor(iteration / NORMALS.length) % READS,
    tenant.businessId,
    tenant.token,
    { class: "normal", stage: stageOf() },
  );
}

export function noisy() {
  const iteration = exec.scenario.iterationInTest;
  const token = context.managerTokens[iteration % context.managerTokens.length];

  read(iteration % READS, context.businessId, token, {
    class: "noisy",
    stage: "noisy",
  });
}

import { sleep } from "k6";
import { Counter } from "k6/metrics";

import {
  SUMMARY_TREND_STATS,
  breakdownOf,
  context,
  retryAfterOf,
  surfaces,
} from "./lib/api.js";

/**
 * The Torre left open, the way offices leave it (plano-escala LOAD-03,
 * F4-60): 50 tabs of the company measured plus 500 companies with 2 tabs
 * each, every tab reading the tower and the bell's list
 * (`/notification/stream?limit=50`) at each tick.
 *
 * The tick is the web's (F2-29, decision D25): the period of the cadence
 * the tab chose, aligned to the clock, plus an offset each tab draws once,
 * uniform over the WHOLE period, so the platform's towers do not all read
 * in the first seconds of each minute. A read refused with Retry-After
 * (the panel budget, load shedding) holds the tab's next reads for
 * max(Retry-After, period) from the refusal, as the web's `readsHeldUntil`
 * does. No socket here: the dots ride the socket, and socket-fleet (LOAD-05)
 * measures those.
 *
 *   TOWER_PERIOD_MS         the cadence (60000; the web offers 1, 3 or 5 min)
 *   TOWER_PRIMARY_TABS      tabs of the company measured (50)
 *   TOWER_TENANTS           other companies (500, of the seed's
 *                           panelTenants: LOAD_PANEL_TENANTS)
 *   TOWER_TABS_PER_TENANT   tabs of each (2)
 *   TOWER_DURATION          how long (10m)
 */
const PERIOD_MS = Number(__ENV.TOWER_PERIOD_MS || 60_000);

const PRIMARY_TABS = Math.min(
  Number(__ENV.TOWER_PRIMARY_TABS || 50),
  context.managerTokens.length,
);

const TENANTS = (context.panelTenants || []).slice(
  0,
  Number(__ENV.TOWER_TENANTS || 500),
);

const TABS_PER_TENANT = Number(__ENV.TOWER_TABS_PER_TENANT || 2);

const TABS = PRIMARY_TABS + TENANTS.length * TABS_PER_TENANT;

/** Reads the API refused with a wait, which held the tab's next beats. */
const refused = new Counter("tower_reads_refused");

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,

  scenarios: {
    tabs: {
      executor: "constant-vus",
      vus: Math.max(1, TABS),
      duration: __ENV.TOWER_DURATION || "10m",
      gracefulStop: "10s",
    },
  },

  thresholds: {
    ...breakdownOf("tab", ["primary", "tenant"]),

    "surface_latency{surface:route.tower}": ["p(95)<1500"],
    "surface_latency{surface:notification.stream}": ["p(95)<1000"],
    "surface_failures{surface:route.tower}": ["rate<0.01"],
    "surface_failures{surface:notification.stream}": ["rate<0.01"],
    "surface_throttled{surface:route.tower}": ["rate>=0"],
    "surface_shed{surface:route.tower}": ["rate>=0"],

    tower_reads_refused: ["count>=0"],
  },
};

/** The company, the session and the class of this VU's tab. */
function tabOf(index) {
  if (index < PRIMARY_TABS) {
    return {
      businessId: context.businessId,
      token: context.managerTokens[index],
      tab: "primary",
    };
  }

  const tenant =
    TENANTS[Math.floor((index - PRIMARY_TABS) / TABS_PER_TENANT)] ?? TENANTS[0];

  // A fixture with no other companies: every tab is the primary's.
  if (!tenant) {
    return {
      businessId: context.businessId,
      token: context.managerTokens[index % context.managerTokens.length],
      tab: "primary",
    };
  }

  return { businessId: tenant.businessId, token: tenant.token, tab: "tenant" };
}

/** The first instant after `now` on this tab's beat: k·period + offset. */
function nextBeat(now, offsetMs) {
  return (Math.floor((now - offsetMs) / PERIOD_MS) + 1) * PERIOD_MS + offsetMs;
}

// Per VU: one tab.
let tab = null;
let offsetMs = 0;
let heldUntil = 0;

export function setup() {
  if (TENANTS.length === 0) {
    console.warn(
      "tower.js: o fixture não tem panelTenants; só as abas da empresa principal. " +
        "Semeie com LOAD_PANEL_TENANTS (seed.ts).",
    );
  }
}

export default function tower() {
  if (!tab) {
    tab = tabOf(__VU - 1);
    offsetMs = Math.floor(Math.random() * PERIOD_MS);

    // The first read on the tab's own beat, not at the run's first second.
    sleep(Math.max(0, nextBeat(Date.now(), offsetMs) - Date.now()) / 1000);
  }

  const tags = { tab: tab.tab };
  const reads = [
    surfaces.tenantTower(tab.businessId, tab.token, tags),
    surfaces.notificationStream(tab.token, tags),
  ];

  for (const response of reads) {
    const retryAfter = retryAfterOf(response);

    if (
      (response.status === 429 || response.status === 503) &&
      retryAfter !== null
    ) {
      refused.add(1, tags);
      heldUntil = Math.max(
        heldUntil,
        Date.now() + Math.max(retryAfter * 1000, PERIOD_MS),
      );
    }
  }

  // The next beat, or the first one past the hold.

  const beat = nextBeat(Math.max(Date.now(), heldUntil - 1), offsetMs);

  sleep(Math.max(0, beat - Date.now()) / 1000);
}

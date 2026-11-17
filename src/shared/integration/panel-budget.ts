import type { FastifyRequest } from "fastify";

import { env } from "@/env";
import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import { routeGroupOf } from "@/shared/health/route-groups";
import { integrationRateGuard } from "@/shared/integration/integration-rate-guard";

/**
 * Each company's budget of panel requests per minute, weighted by what a
 * request costs, with each person's slice of it (plano-escala F2-28,
 * decision D41).
 *
 * The rate limiter keeps one person to 300 requests a minute, whatever they
 * are: a detail and the tower's board, the export of the whole history and
 * a badge count weigh the same. At 3,600 carriers on one database, one
 * company whose dispatch room keeps twenty towers and a few exports open
 * spends the pool every other company waits on. So every panel request
 * also spends units of its company's minute (TENANT_PANEL_BUDGET_PER_MINUTE,
 * 6,000): a detail 1, the tower 3, a list 5 (10 when the deliveries or
 * routes are asked for every date), an export 20.
 *
 * Twice, on purpose, around the session lookup in `ensureAuthenticated`:
 *
 *  - BEFORE it, only the person's slice (`panel-user:<sub>`, up to
 *    TENANT_PANEL_USER_SHARE of the company's budget, 25%), keyed by the
 *    access token's verified signature (shared/auth/access-token-once.ts).
 *    A token whose session was revoked still verifies until it expires; in
 *    a loop it is refused here, without the lookup, and never reaches the
 *    company's budget;
 *  - AFTER it, the company's (`panel:<businessId>`), with the company the
 *    database just confirmed. One person can never spend more than their
 *    slice of it, so nobody alone empties the budget of everybody else.
 *
 * Only panel sessions pay: a driver's session (its submissions are the
 * product working) and the MASTER (the platform's own staff) never do, nor
 * the public API (its keys have ceilings of their own).
 *
 * `TENANT_PANEL_BUDGET_MODE=observe` (the default) refuses nothing: it
 * counts what enforce would refuse in the `panel_budget` section of
 * /health/metrics and of the ops_sample row, for the owner to read before
 * switching. `enforce` answers 429 TENANT_BUSY with Retry-After (when the
 * minute ends). `off` does not spend anything. Redis holds counters only,
 * and every error fails open (ADR 0002): an outage costs the budget, never
 * a request.
 */

type PanelBudgetMode = "off" | "observe" | "enforce";

/** The listings that take a `period` and read every date without one. */
const PERIOD_LISTS = new Set([
  "GET /delivery/list-delivery",
  "GET /route/list-routes",
]);

const EXPORT_ROUTE = /\/export-[a-z-]+$/;

/** Units a route's request costs; `config.panelCost` when it declares one. */
function panelCostOf(method: string, url: string | undefined): number {
  if (url !== undefined && method === "GET" && EXPORT_ROUTE.test(url)) {
    return 20;
  }

  const group = routeGroupOf(method, url);

  if (group === "tower") return 3;
  if (group === "lists") return 5;

  return 1;
}

/** The request's cost: the route's, doubled for a listing of every date. */
function panelCostFor(request: FastifyRequest): number {
  const declared = request.routeOptions?.config?.panelCost;
  const base =
    typeof declared === "number" && declared > 0
      ? declared
      : panelCostOf(request.method, request.routeOptions?.url);

  const route = `${request.method} ${request.routeOptions?.url ?? ""}`;
  const period = (request.query as { period?: unknown } | undefined)?.period;

  return PERIOD_LISTS.has(route) && (period === undefined || period === "")
    ? base * 2
    : base;
}

/** A panel session: not a driver's, not the platform's. */
function isPanelSession(who: {
  role?: string | null;
  driverId?: string | null;
}): boolean {
  return who.role !== "MASTER" && !who.driverId;
}

const panelUserKey = (sub: string): string => `panel-user:${sub}`;
const panelTenantKey = (businessId: string): string => `panel:${businessId}`;

/** The person's slice of the company's budget, in units. */
function panelUserBudget(): number {
  return Math.max(
    1,
    Math.floor(
      env.TENANT_PANEL_BUDGET_PER_MINUTE * env.TENANT_PANEL_USER_SHARE,
    ),
  );
}

type BudgetScope = "user" | "tenant";

interface PanelBudgetSample {
  window_seconds: number;
  mode: PanelBudgetMode;
  budget_per_minute: number;
  user_share: number;
  /** Requests that spent from a budget (user's slice, then the company). */
  charged: Record<BudgetScope, number>;
  /** Over the budget, let through because of observe. */
  would_refuse: Record<BudgetScope, number>;
  /** Refused with 429 TENANT_BUSY. */
  refused: Record<BudgetScope, number>;
  /** Redis did not answer: let through uncounted (fail open). */
  unavailable: number;
}

interface PanelBudgetMetrics {
  record(scope: BudgetScope, outcome: "charged" | "over" | "refused"): void;
  recordUnavailable(): void;
  snapshot(): PanelBudgetSample;
  rotate(): PanelBudgetSample;
}

function createPanelBudgetMetrics({
  now = Date.now,
}: { now?: () => number } = {}): PanelBudgetMetrics {
  const zero = () => ({ user: 0, tenant: 0 });

  let startedAt = now();
  let charged = zero();
  let wouldRefuse = zero();
  let refused = zero();
  let unavailable = 0;

  function snapshot(): PanelBudgetSample {
    return {
      window_seconds: Math.round((now() - startedAt) / 100) / 10,
      mode: env.TENANT_PANEL_BUDGET_MODE as PanelBudgetMode,
      budget_per_minute: env.TENANT_PANEL_BUDGET_PER_MINUTE,
      user_share: env.TENANT_PANEL_USER_SHARE,
      charged: { ...charged },
      would_refuse: { ...wouldRefuse },
      refused: { ...refused },
      unavailable,
    };
  }

  return {
    record(scope, outcome) {
      charged[scope] += 1;
      if (outcome === "over") wouldRefuse[scope] += 1;
      if (outcome === "refused") refused[scope] += 1;
    },

    recordUnavailable() {
      unavailable += 1;
    },

    snapshot,

    rotate() {
      const sample = snapshot();

      startedAt = now();
      charged = zero();
      wouldRefuse = zero();
      refused = zero();
      unavailable = 0;

      return sample;
    },
  };
}

/** The process-wide counters: the charges write them, the sample reads them. */
const panelBudgetMetrics = createPanelBudgetMetrics();

/**
 * Requests whose person was over their slice in observe: they do not spend
 * the company's budget either, so what observe counts is what enforce
 * would refuse, and one person's flood is never booked to everybody else.
 */
const overTheirSlice = new WeakSet<object>();

function tenantBusy(scope: BudgetScope, resetInMs: number): ServiceBusyError {
  const retryAfter = Math.max(1, Math.ceil(resetInMs / 1000));

  return scope === "user"
    ? new ServiceBusyError(
        "Você fez requisições demais neste minuto. Tente de novo em instantes.",
        "TENANT_BUSY",
        retryAfter,
        429,
      )
    : new ServiceBusyError(
        "A sua empresa fez requisições demais neste minuto. Tente de novo em instantes.",
        "TENANT_BUSY",
        retryAfter,
        429,
      );
}

async function spend(
  scope: BudgetScope,
  key: string,
  cost: number,
  budget: number,
): Promise<{ over: boolean; resetInMs: number } | null> {
  const spent = await integrationRateGuard.spendPanelBudget(key, cost);

  if (!spent) {
    panelBudgetMetrics.recordUnavailable();
    return null;
  }

  return { over: spent.total > budget, resetInMs: spent.resetInMs };
}

/**
 * The person's slice, before the session lookup. `claims` are the access
 * token's, verified: who it names, never what they may do. Throws
 * TENANT_BUSY in enforce; otherwise only counts.
 */
async function chargePanelUser(
  request: FastifyRequest,
  claims: { sub?: string; role?: string | null; driverId?: string | null },
): Promise<void> {
  const mode = env.TENANT_PANEL_BUDGET_MODE as PanelBudgetMode;

  if (mode === "off" || !claims.sub || !isPanelSession(claims)) return;

  const outcome = await spend(
    "user",
    panelUserKey(claims.sub),
    panelCostFor(request),
    panelUserBudget(),
  );

  if (!outcome) return;

  if (!outcome.over) {
    panelBudgetMetrics.record("user", "charged");
    return;
  }

  if (mode === "enforce") {
    panelBudgetMetrics.record("user", "refused");
    throw tenantBusy("user", outcome.resetInMs);
  }

  panelBudgetMetrics.record("user", "over");
  overTheirSlice.add(request);
}

/**
 * The company's budget, after the session lookup confirmed who and which
 * company (`request.user`). Throws TENANT_BUSY in enforce.
 */
async function chargePanelTenant(request: FastifyRequest): Promise<void> {
  const mode = env.TENANT_PANEL_BUDGET_MODE as PanelBudgetMode;
  const user = request.user;

  if (mode === "off" || !user?.businessId || !isPanelSession(user)) return;
  if (overTheirSlice.has(request)) return;

  const outcome = await spend(
    "tenant",
    panelTenantKey(user.businessId),
    panelCostFor(request),
    env.TENANT_PANEL_BUDGET_PER_MINUTE,
  );

  if (!outcome) return;

  if (!outcome.over) {
    panelBudgetMetrics.record("tenant", "charged");
    return;
  }

  if (mode === "enforce") {
    panelBudgetMetrics.record("tenant", "refused");
    throw tenantBusy("tenant", outcome.resetInMs);
  }

  panelBudgetMetrics.record("tenant", "over");
}

export {
  PERIOD_LISTS,
  chargePanelTenant,
  chargePanelUser,
  createPanelBudgetMetrics,
  isPanelSession,
  panelBudgetMetrics,
  panelCostFor,
  panelCostOf,
  panelTenantKey,
  panelUserBudget,
  panelUserKey,
  type PanelBudgetMode,
  type PanelBudgetSample,
};

import { env } from "@/env";
import { withoutRequestContext } from "@/shared/http/request-context";
import { logger } from "@/shared/logging/logger";
import {
  countRollupFailure,
  countRollupFallback,
  countRollupSkip,
  countRollupWindow,
} from "@/shared/rollup/dashboard-rollup-metrics";

import type {
  DeliveriesFromRollup,
  DeliveryWindow,
  PeriodCountBucket,
} from "../../dtos/dashboard-dto";
import type { IDashboardRepository } from "../../repositories/IDashboard-repository";

const log = logger.child({ component: "dashboard-rollup" });

/**
 * Where the overview and the trends take their "Entregas" series from
 * (plano-escala F4-22, decision D52; DASHBOARD_ROLLUP_MODE):
 *  - off: counted live, as before;
 *  - shadow (the default): counted live and served, then compared on the
 *    side with the closed days of tenant_day_count; what differs is
 *    counted in /health/metrics and logged;
 *  - on: the closed days stored, added to a live count of what is not.
 */
type DashboardRollupMode = "off" | "shadow" | "on";

/** Read on every view, so a test can flip it; in a deployment, a redeploy. */
function dashboardRollupMode(): DashboardRollupMode {
  return env.DASHBOARD_ROLLUP_MODE;
}

/**
 * The rollup option of a view's reads: only with "on" and when the view
 * shows the series at all (the company hired Entregas and the profile may
 * read deliveries). `now` is the view's own clock, so both sides agree on
 * which days are over.
 */
function deliveriesFromRollup(
  mode: DashboardRollupMode,
  showsDeliveries: boolean,
  now: Date,
): DeliveriesFromRollup | undefined {
  return mode === "on" && showsDeliveries ? { now } : undefined;
}

/**
 * A read of the view with the rollup's option, and again without it if
 * that read fails: the screen every login opens must not go down with a
 * new table (a statement error, a missing grant). The fallback is counted
 * (on_fallbacks) and logged.
 */
async function readWithRollup<T>(
  rollup: DeliveriesFromRollup | undefined,
  read: (rollup?: DeliveriesFromRollup) => Promise<T>,
  screen: DashboardScreen,
): Promise<T> {
  if (!rollup) return read(undefined);

  try {
    return await read(rollup);
  } catch (error) {
    countRollupFallback();
    log.warn(
      { err: error, screen },
      "dashboard rollup read failed; deliveries counted live",
    );

    return read(undefined);
  }
}

type DashboardScreen = "overview" | "trends";

/** A window the screen served, with the deliveries it served for it. */
interface ServedWindow extends DeliveryWindow {
  served: readonly PeriodCountBucket[];
}

/**
 * The comparison in flight in this process: one at most. The shadow costs
 * one cheap statement per view (two only when the first one disagrees), on
 * the request's pool but after its answer; one at a time, it can never
 * hold more than one connection, whatever the traffic. A view that finds
 * one running is not compared (views_skipped): the shadow is a sample.
 */
let running: Promise<void> | null = null;

/** Two answers are the same when every non-empty bucket has the same count. */
function sameBuckets(
  a: readonly PeriodCountBucket[],
  b: readonly PeriodCountBucket[],
): boolean {
  const nonEmpty = (buckets: readonly PeriodCountBucket[]) =>
    new Map(
      buckets
        .filter((bucket) => bucket.count !== 0)
        .map((bucket) => [bucket.period, bucket.count]),
    );

  const left = nonEmpty(a);
  const right = nonEmpty(b);

  if (left.size !== right.size) return false;

  for (const [period, count] of left) {
    if (right.get(period) !== count) return false;
  }

  return true;
}

function windowOf({ from, to, granularity }: DeliveryWindow): DeliveryWindow {
  return { from, to, granularity };
}

/**
 * The comparison itself. First the rollup alone (cheap: the stored days and
 * a live count of the rest) against what the screen served. Only the
 * windows that disagree are read again, the rollup and the live count in
 * ONE statement: one snapshot, so a disagreement there is a stored day
 * that is wrong (diverged), and agreement means the data moved between the
 * screen's read and the first comparison (raced).
 */
async function compareWindows(input: {
  repository: IDashboardRepository;
  screen: DashboardScreen;
  businessId?: string;
  timeZone: string;
  now: Date;
  windows: readonly ServedWindow[];
}): Promise<void> {
  const { repository, screen, businessId, timeZone, now, windows } = input;

  const rolled = await repository.countDeliveryWindows(
    { windows: windows.map(windowOf), timeZone, now, sources: ["rollup"] },
    businessId,
  );

  const moved: number[] = [];

  windows.forEach((window, index) => {
    if (sameBuckets(window.served, rolled[index]?.rollup ?? [])) {
      countRollupWindow("agreed");
    } else {
      moved.push(index);
    }
  });

  if (moved.length === 0) return;

  const confirmed = await repository.countDeliveryWindows(
    {
      windows: moved.map((index) => windowOf(windows[index])),
      timeZone,
      now,
      sources: ["live", "rollup"],
    },
    businessId,
  );

  moved.forEach((index, at) => {
    const live = confirmed[at]?.live ?? [];
    const rollup = confirmed[at]?.rollup ?? [];

    if (sameBuckets(live, rollup)) {
      countRollupWindow("raced");

      return;
    }

    countRollupWindow("diverged");

    // The durable record of the shadow (dashboard-rollup-metrics.ts): ids,
    // the window and counts only.
    log.warn(
      {
        screen,
        businessId: businessId ?? null,
        timeZone,
        window: {
          from: windows[index].from.toISOString(),
          to: windows[index].to.toISOString(),
          granularity: windows[index].granularity,
        },
        live,
        rollup,
      },
      "dashboard rollup diverged from the live count",
    );
  });
}

/**
 * Compares, on the side, what a view served with what the rollup would
 * have served (DASHBOARD_ROLLUP_MODE=shadow). Never awaited by the view and
 * never throws: the answer has gone already and stays today's. Outside the
 * request that started it, which it outlives (request-context.ts).
 */
function shadowDeliveryRollup(input: {
  repository: IDashboardRepository;
  screen: DashboardScreen;
  businessId?: string;
  timeZone: string;
  now: Date;
  windows: readonly ServedWindow[];
}): void {
  if (input.windows.length === 0) return;

  if (running) {
    countRollupSkip();

    return;
  }

  running = withoutRequestContext(() =>
    compareWindows(input)
      .catch((error) => {
        countRollupFailure();
        log.warn(
          { err: error, screen: input.screen },
          "dashboard rollup comparison failed",
        );
      })
      .finally(() => {
        running = null;
      }),
  );
}

/** For tests: resolves once the comparison in flight, if any, is over. */
async function dashboardRollupShadowIdle(): Promise<void> {
  while (running) await running;
}

export {
  dashboardRollupMode,
  dashboardRollupShadowIdle,
  deliveriesFromRollup,
  readWithRollup,
  sameBuckets,
  shadowDeliveryRollup,
};
export type { DashboardRollupMode, DashboardScreen, ServedWindow };

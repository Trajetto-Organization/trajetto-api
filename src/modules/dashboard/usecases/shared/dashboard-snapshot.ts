import { env } from "@/env";
import {
  TenantSnapshot,
  type TenantSnapshotMemory,
  type TenantSnapshotVariant,
} from "@/shared/cache/tenant-snapshot";

import type { DashboardEntity } from "../../dtos/dashboard-dto";

/**
 * A company's dashboard numbers, kept for a minute in this process's memory
 * (plano-escala F4-23, decision D2 of 15/11/2026: "Dashboard: foto de 60 s
 * por visibilidade"; the rules of the tenant snapshot are in
 * src/shared/cache/tenant-snapshot.ts and in the 19/11/2026 addendum of
 * ADR 0002).
 *
 * The overview and the trend chart are the heaviest reads of the panel:
 * grouped counts over months of every series, the fleet, the maintenance
 * and the costs. Every manager of a carrier opens them on every visit to
 * the panel, and two managers who may see the same things are shown the
 * same numbers. So each process reads them once per
 * DASHBOARD_SNAPSHOT_TTL_MS for each company and each VISIBILITY.
 *
 * Unlike the tower, the answer depends on who asks: a profile limited to
 * the fleet must never receive the deliveries a dispatcher's copy counted.
 * The variant is therefore the fingerprint of what the viewer is shown
 * (the series, and each block the use case reads or leaves out), and the
 * computation receives that fingerprint and the company, never the viewer.
 * Two viewers share a copy exactly when every input of the computation is
 * the same, so a copy can only ever be the numbers its key describes.
 *
 * What stays out of it:
 *  - the recent activity, which names people and is filtered by the viewer,
 *    is read on every view and added to the copy's numbers;
 *  - the MASTER, who has no company: their platform-wide overview has its
 *    own snapshot (MasterOverviewSnapshots, snapshot-cache.ts), and their
 *    trends are read on every view;
 *  - the role and the session: the route's guards and the use case's user
 *    lookup run on every request, before the snapshot is looked at.
 *
 * No ETag here: the overview's body carries the per-view activity, and no
 * client revalidates these reads (the tower's 304 is for a panel that polls
 * every few seconds; the dashboard is read once per visit).
 */

/** What the overview shows a viewer: every input of its numbers. */
interface OverviewVisibility {
  /** The series it receives, in DASHBOARD_ENTITIES order. */
  entities: readonly DashboardEntity[];

  /** The fleet blocks: the vehicles by status and by type. */
  vehicles: boolean;

  /** The maintenance due (the vehicles, in a company with Frotas). */
  maintenance: boolean;

  /** The maintenance costs (service orders, in a company with Frotas). */
  costs: boolean;

  /** Today's operation (Entregas, for a manager who reads deliveries). */
  operation: boolean;
}

/** What the trend chart shows a viewer. */
interface TrendsVisibility {
  entities: readonly DashboardEntity[];
  costs: boolean;
}

/**
 * The overview's key besides the company: the visibility and the company's
 * zone. The zone is the company's, not the viewer's; it is in the key so
 * the computation never reads it again outside the request (the session
 * already brought it), and so a change of zone is a new copy at once.
 */
function overviewVariant(
  visibility: OverviewVisibility,
  timeZone: string,
): TenantSnapshotVariant {
  return {
    timeZone,
    series: visibility.entities.join(","),
    vehicles: visibility.vehicles,
    maintenance: visibility.maintenance,
    costs: visibility.costs,
    operation: visibility.operation,
  };
}

/** The trend chart's key besides the company: the period, too. */
function trendsVariant(
  period: string,
  visibility: TrendsVisibility,
  timeZone: string,
): TenantSnapshotVariant {
  return {
    period,
    timeZone,
    series: visibility.entities.join(","),
    costs: visibility.costs,
  };
}

/**
 * A dashboard snapshot. JSON is the body: the numbers are plain numbers and
 * strings (the repository converts every count), and each hit parses its
 * own copy, so no two requests ever share one mutable object.
 */
function dashboardSnapshot<T>(
  name: string,
  memory?: TenantSnapshotMemory,
): TenantSnapshot<T> {
  return new TenantSnapshot<T>({
    name,
    ttlMs: () => env.DASHBOARD_SNAPSHOT_TTL_MS,
    memory,
  });
}

/**
 * The numbers through the company's snapshot, or computed in this request
 * when there is none to read: no snapshot given (the suites that build the
 * use case by hand), the snapshot off (DASHBOARD_SNAPSHOT_TTL_MS=0, the
 * path of before, unchanged), or no company (the MASTER).
 */
async function readDashboardNumbers<T>(
  snapshot: TenantSnapshot<T> | undefined,
  input: {
    businessId: string | undefined;
    variant: TenantSnapshotVariant;
    compute: () => Promise<T>;
  },
): Promise<T> {
  const { businessId, variant, compute } = input;

  if (!snapshot || !snapshot.enabled || !businessId) {
    return compute();
  }

  const read = await snapshot.read({ businessId, variant, compute });

  return JSON.parse(read.body) as T;
}

export {
  dashboardSnapshot,
  overviewVariant,
  readDashboardNumbers,
  trendsVariant,
  type OverviewVisibility,
  type TrendsVisibility,
};

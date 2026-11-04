import type { Prisma, PrismaClient } from "@prisma/client";

import { OPEN_STOP_STATUSES } from "./route-rules";

/**
 * The running routes that left before `startedBefore` (leftOpenStartedBefore:
 * exactly the routes isRouteLeftOpen calls forgotten) with their open stops
 * counted, routes holding none left out (plan of 02/11/2026, H3). What the
 * deliveries list's "Em rota" card and the operation summary inherited.
 *
 * Two reads, on purpose. The routes first, by route (businessId, status,
 * …): a day without a forgotten route stops there and reads no stop. Then
 * only THOSE routes' stops, grouped, by route_stop (routeId, status). A
 * filtered relation `_count` in one query looked equivalent, but Prisma
 * writes it as a LEFT JOIN on a sub-select grouped over every open stop of
 * the database — every tenant's — and joins the routes afterwards
 * (query-plans.test.ts measured 1.600 stops read to count 2 routes' 40).
 *
 * `stops` narrows the stops counted (the list counts only its own matches);
 * without it every open stop counts, as on the tower.
 */
async function openStopsOnRoutesLeftOpen(
  prisma: Pick<PrismaClient, "route" | "routeStop">,
  {
    businessId,
    startedBefore,
    stops,
  }: {
    businessId: string;
    startedBefore: Date;
    stops?: Prisma.RouteStopWhereInput;
  },
): Promise<Array<{ started_at: Date | null; open: number }>> {
  const routes = await prisma.route.findMany({
    where: {
      businessId,
      status: "IN_PROGRESS",
      started_at: { lt: startedBefore },
    },
    select: { id: true, started_at: true },
  });

  if (routes.length === 0) return [];

  const counted = await prisma.routeStop.groupBy({
    by: ["routeId"],
    where: {
      routeId: { in: routes.map((route) => route.id) },
      status: { in: [...OPEN_STOP_STATUSES] },
      ...stops,
    },
    _count: { _all: true },
  });

  const openByRoute = new Map(
    counted.map((group) => [group.routeId, group._count._all]),
  );

  return routes
    .map((route) => ({
      started_at: route.started_at,
      open: openByRoute.get(route.id) ?? 0,
    }))
    .filter((route) => route.open > 0);
}

export { openStopsOnRoutesLeftOpen };

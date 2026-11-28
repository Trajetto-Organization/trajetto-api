/**
 * The route columns of the fleet lists (contract C3 of 03/11/2026): the
 * refuelling list, a vehicle's refuelling history and the checklist list
 * name the route each record was made on, so the web links the row to the
 * route's page and shows its moment.
 *
 * Tenant-scoped on purpose: the foreign key lets a row point at any route,
 * and a row of one company naming another company's route (the contract
 * suites seed one) must never read that route's code. Such a route — or one
 * deleted since (SET NULL never leaves a dangling id, but a twin might) —
 * reads as no route. The code goes out as text, as the contract fixes it.
 */
interface ListedRoute {
  id: string;
  code: string;
}

/** The joined route row: what the queries select to decide. */
interface RouteLinkRow {
  id: string;
  code: number;
  businessId: string;
}

type ListedPhase = "ROUTE_START" | "ROUTE_END" | null;

function listedRoute(
  row: { businessId: string; routeId?: string | null },
  route: RouteLinkRow | null | undefined,
): ListedRoute | null {
  if (!row.routeId || !route) return null;
  if (route.id !== row.routeId || route.businessId !== row.businessId) {
    return null;
  }

  return { id: route.id, code: String(route.code) };
}

/** STANDALONE (made outside a route, every legacy row) lists as null. */
function listedPhase(phase: string | null | undefined): ListedPhase {
  return phase === "ROUTE_START" || phase === "ROUTE_END" ? phase : null;
}

/** What the list queries join to fill `route` (id, code and company). */
const ROUTE_LINK_SELECT = {
  select: { id: true, code: true, businessId: true },
} as const;

export { ROUTE_LINK_SELECT, listedPhase, listedRoute };
export type { ListedPhase, ListedRoute, RouteLinkRow };

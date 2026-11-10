import { logger } from "@/shared/logging/logger";
import {
  sendRouteEventToDriver,
  sendRouteStopsLocatedToBusiness,
} from "@/websocket";

import type { SettledLookup } from "./delivery-geocoding-service";
import type {
  IDeliveryGeocodingRepository,
  OpenStopRoute,
} from "./geocoding-repository";

/**
 * Who hears that a run ended the lookup of some addresses (owner's report
 * of 09/11/2026: the route page said "Sem localização" until a reload, even
 * after the point had been found). The settle writes quietly — no
 * plan_version, as a found point is not a dispatcher's edit of the plan —
 * so this is the only way an open page learns of it:
 *
 * - the operations room of the route's company, once per route, as
 *   `routeStopsLocated` with the deliveries: the route page refetches;
 * - the driver of a released or running route, as the routeEvent
 *   `route-stop.located`, only when a point was found: the app refetches
 *   the day silently and its geofence measures from the new point.
 *
 * Only the unfinished routes holding the deliveries as open stops, and
 * only a stop of the same company as the delivery the claim carried — the
 * route row decides the room, and a route of another company never hears
 * about this one's delivery.
 */
interface StopsLocatedAnnouncements {
  business: Array<{
    businessId: string;
    routeId: string;
    deliveryIds: string[];
  }>;
  drivers: Array<{ driverUserId: string; routeId: string }>;
}

function stopsLocatedAnnouncements(
  settled: readonly SettledLookup[],
  stops: readonly OpenStopRoute[],
): StopsLocatedAnnouncements {
  const byId = new Map(settled.map((lookup) => [lookup.id, lookup]));
  const routes = new Map<
    string,
    { stop: OpenStopRoute; deliveryIds: string[]; resolved: boolean }
  >();

  for (const stop of stops) {
    const lookup = byId.get(stop.deliveryId);

    if (!lookup || lookup.businessId !== stop.businessId) continue;

    const entry = routes.get(stop.routeId) ?? {
      stop,
      deliveryIds: [],
      resolved: false,
    };

    if (!entry.deliveryIds.includes(stop.deliveryId)) {
      entry.deliveryIds.push(stop.deliveryId);
    }

    entry.resolved ||= lookup.kind === "RESOLVED";
    routes.set(stop.routeId, entry);
  }

  const announcements: StopsLocatedAnnouncements = {
    business: [],
    drivers: [],
  };

  for (const [routeId, { stop, deliveryIds, resolved }] of routes) {
    announcements.business.push({
      businessId: stop.businessId,
      routeId,
      deliveryIds,
    });

    const theirs =
      stop.routeStatus === "RELEASED" || stop.routeStatus === "IN_PROGRESS";

    if (resolved && theirs && stop.driverUserId) {
      announcements.drivers.push({
        driverUserId: stop.driverUserId,
        routeId,
      });
    }
  }

  return announcements;
}

const log = logger.child({ component: "geocoding" });

/**
 * After the settles' writes. Never throws: the points are already stored,
 * and a page that missed the hint shows them on its next read.
 */
async function announceSettledLookups(
  repository: Pick<IDeliveryGeocodingRepository, "openStopRoutes">,
  settled: readonly SettledLookup[],
): Promise<void> {
  if (settled.length === 0) return;

  try {
    const stops = await repository.openStopRoutes(
      settled.map((lookup) => lookup.id),
    );
    const { business, drivers } = stopsLocatedAnnouncements(settled, stops);

    for (const { businessId, routeId, deliveryIds } of business) {
      sendRouteStopsLocatedToBusiness(businessId, { routeId, deliveryIds });
    }

    for (const { driverUserId, routeId } of drivers) {
      sendRouteEventToDriver(driverUserId, {
        type: "route-stop.located",
        routeId,
      });
    }
  } catch (err) {
    log.warn({ err }, "geocoded stops could not be announced");
  }
}

export { announceSettledLookups, stopsLocatedAnnouncements };
export type { StopsLocatedAnnouncements };

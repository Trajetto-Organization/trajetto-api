import { inject, injectable } from "tsyringe";

// The pause module registers its repository itself; the journey is read
// through it (decision 14.4).
import "@/modules/driver-pause/container";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { IOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/IOccurrence-type-repository";
import type {
  ActiveOccurrenceType,
  DeliveredOccurrenceType,
  PauseOccurrenceType,
} from "@/modules/occurrence-type/dtos/occurrence-type-dto";
import type { IDriverPauseRepository } from "@/modules/driver-pause/repositories/IDriver-pause-repository";
import { journeyAt } from "@/modules/driver-pause/usecases/pause-type-and-journey";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import type { IBusinessSettingsRepository } from "@/modules/business/repositories/IBusiness-settings-repository";
import type { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";
import type { RouteChecklistSummary } from "@/modules/vehicle-checklist/dtos/vehicle-checklist-dto";
import { resolveEnabledModules } from "@/modules/user/usecases/get-user/get-user-usecase";
import {
  effectiveBusinessSettings,
  type BusinessSettingsValues,
} from "@/shared/business/business-settings";
// The arrival checklist window lives with the vehicle access rule: the same
// window lets the driver read the ended route's vehicle for that checklist.
import { ENDED_ROUTE_CHECKLIST_WINDOW_MS } from "@/shared/vehicle/driver-vehicle-access";

import { AppError } from "@/shared/errors/AppError";

interface ListMyDeliveriesRequest {
  userId: string;
  businessId: string;
  /** The clock. Only tests pass it. */
  now?: Date;
}

/** The vehicle of a route, as its card shows it (plan of 02/11/2026, C2). */
interface MyDeliveriesRouteVehicle {
  id: string;
  license_plate: string;
}

/** One checklist made for the route, at one moment (C4). */
interface MyDeliveriesRouteChecklist {
  id: string;
  checklist_date: Date | string;
  overall_condition: string;
}

/** A route the list's open stops belong to, with the plan's version. */
interface MyDeliveriesRoute {
  id: string;
  code: number;
  plan_version: number;
  /** C2: null while the route has no vehicle. */
  vehicle: MyDeliveriesRouteVehicle | null;
  /**
   * C4: the newest departure and arrival checklists made for this route;
   * null = not done. What the company requires is in `settings`.
   */
  checklists: {
    route_start: MyDeliveriesRouteChecklist | null;
    route_end: MyDeliveriesRouteChecklist | null;
  };
  /**
   * C4: null for a route with open stops. Set on a route that already ended
   * and is listed only because the company asks for the arrival checklist
   * and it is still missing (ENDED_ROUTE_CHECKLIST_WINDOW_MS).
   */
  completed_at: Date | string | null;
}

interface ListMyDeliveriesResult {
  deliveries: unknown[];
  /**
   * Decision 14.7 (design §4.13/§6): the routes of the open stops, once
   * each, so the app can tell from its cache that a plan changed offline.
   */
  routes: MyDeliveriesRoute[];
  // What really flows: with the form and the tower flag (decisions 6.2/6.3).
  // NOT_DELIVERED only: the installed app (contract <= 2) offers every entry
  // here as a problem to report (decision 14.3).
  occurrenceTypes: ActiveOccurrenceType[];
  /** Decision 14.3 (contract 3): the delivery types, the default first. */
  deliveredTypes: DeliveredOccurrenceType[];
  /** Decision 14.4 (contract 3): the pause types. */
  pauseTypes: PauseOccurrenceType[];
  /** The journey as the server sees it now (decision 14.4). */
  journey: {
    pause_allowed: boolean;
    route_id: string | null;
    /** The company's day the answer is about (YYYY-MM-DD). */
    day: string;
    /** The company's zone, for the app to know when that day ends. */
    time_zone: string;
  };
  /**
   * Plan of 02/11/2026 (M1, M6): the company's settings as the app applies
   * them, cached with the rest for the offline week.
   */
  settings: BusinessSettingsValues;
}

/** The route's vehicle as the stop's route carries it, when well-formed. */
function vehicleOf(value: unknown): MyDeliveriesRouteVehicle | null {
  const vehicle = value as Partial<MyDeliveriesRouteVehicle> | null | undefined;

  return vehicle &&
    typeof vehicle.id === "string" &&
    typeof vehicle.license_plate === "string"
    ? { id: vehicle.id, license_plate: vehicle.license_plate }
    : null;
}

/**
 * The newest checklist of each moment per route, from rows already ordered
 * newest first (listRouteChecklists). Derived, never stored on the route:
 * a checklist with photos that arrives after the start still counts (C4).
 */
function checklistsByRoute(
  rows: RouteChecklistSummary[],
): Map<string, MyDeliveriesRoute["checklists"]> {
  const byRoute = new Map<string, MyDeliveriesRoute["checklists"]>();

  for (const row of rows) {
    const entry = byRoute.get(row.routeId) ?? {
      route_start: null,
      route_end: null,
    };
    const key = row.phase === "ROUTE_START" ? "route_start" : "route_end";

    entry[key] ??= {
      id: row.id,
      checklist_date: row.checklist_date,
      overall_condition: row.overall_condition,
    };

    byRoute.set(row.routeId, entry);
  }

  return byRoute;
}

/** The distinct routes of the deliveries' open stops, in first-seen order. */
function routesOf(
  deliveries: unknown[],
  checklists: Map<string, MyDeliveriesRoute["checklists"]> = new Map(),
): MyDeliveriesRoute[] {
  const routes = new Map<string, MyDeliveriesRoute>();

  for (const delivery of deliveries) {
    const stops = (delivery as { stops?: unknown }).stops;

    if (!Array.isArray(stops)) continue;

    for (const stop of stops) {
      const route = (stop as { route?: Partial<MyDeliveriesRoute> | null })
        .route;

      if (
        route &&
        typeof route.id === "string" &&
        typeof route.code === "number" &&
        typeof route.plan_version === "number" &&
        !routes.has(route.id)
      ) {
        routes.set(route.id, {
          id: route.id,
          code: route.code,
          plan_version: route.plan_version,
          vehicle: vehicleOf((route as { vehicle?: unknown }).vehicle),
          checklists: checklists.get(route.id) ?? {
            route_start: null,
            route_end: null,
          },
          // A route with an open stop has not ended.
          completed_at: null,
        });
      }
    }
  }

  return [...routes.values()];
}

/**
 * The driver's working list, in one payload: own designated (PENDING with
 * driver) and IN_TRANSIT deliveries with shipper and cargo items, the active
 * occurrence types by category and the journey — everything the app's 7-day
 * offline cache needs in a single round trip.
 */
@injectable()
class ListMyDeliveriesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("OccurrenceTypeRepository")
    private occurrenceType: IOccurrenceTypeRepository,
    @inject("DriverPauseRepository")
    private pauses: IDriverPauseRepository,
    @inject("BusinessSettingsRepository")
    private settings: IBusinessSettingsRepository,
    @inject("VehicleChecklistRepository")
    private checklists: IVehicleChecklistRepository,
  ) {}

  async execute({
    userId,
    businessId,
    now = new Date(),
  }: ListMyDeliveriesRequest): Promise<ListMyDeliveriesResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (!findUser.driverId) {
      throw new AppError(
        "Esta rota é do aplicativo do motorista: apenas usuários vinculados a um motorista têm lista de entregas.",
        403,
        "DRIVER_ONLY",
      );
    }

    const [deliveries, occurrenceTypes] = await Promise.all([
      this.delivery.listDriverDeliveries(businessId, findUser.driverId),
      this.occurrenceType.listActiveOccurrenceTypes(businessId),
    ]);

    let deliveredTypes =
      await this.occurrenceType.listActiveDeliveredTypes(businessId);
    let pauseTypes = await this.occurrenceType.listActivePauseTypes(businessId);

    // The catalogue keeps one active type of each (LAST_OF_CATEGORY): none
    // means the company was never seeded, so seed it now (design §3).
    if (deliveredTypes.length === 0 || pauseTypes.length === 0) {
      await this.occurrenceType.ensureDefaultTypes(businessId);

      deliveredTypes =
        await this.occurrenceType.listActiveDeliveredTypes(businessId);
      pauseTypes = await this.occurrenceType.listActivePauseTypes(businessId);
    }

    const journey = await journeyAt(
      this.pauses,
      businessId,
      findUser.driverId,
      now,
    );

    // The company's settings with the module rule applied (M6). The tenant
    // guard made the path's company the driver's own, so the session's
    // modules are this company's.
    const settings = effectiveBusinessSettings(
      await this.settings.findByBusinessId(businessId),
      resolveEnabledModules(findUser),
    );

    // C4: a route that ended without the arrival checklist the company asks
    // for stays listed (after the open ones) until it is made, for a day.
    const asksOnArrival =
      settings.checklist_requirement === "ROUTE_END" ||
      settings.checklist_requirement === "ROUTE_START_AND_END";

    const openRoutes = routesOf(deliveries);

    const endedRoutes = asksOnArrival
      ? (
          await this.checklists.listRoutesAwaitingEndChecklist({
            businessId,
            driverId: findUser.driverId,
            completedSince: new Date(
              now.getTime() - ENDED_ROUTE_CHECKLIST_WINDOW_MS,
            ),
          })
        ).filter((ended) => !openRoutes.some((open) => open.id === ended.id))
      : [];

    // Every listed route's checklists in one read (none without a route).
    const checklists = checklistsByRoute(
      await this.checklists.listRouteChecklists(businessId, [
        ...openRoutes.map((route) => route.id),
        ...endedRoutes.map((route) => route.id),
      ]),
    );

    return {
      deliveries,
      routes: [
        ...routesOf(deliveries, checklists),
        ...endedRoutes.map((route) => ({
          ...route,
          checklists: checklists.get(route.id) ?? {
            route_start: null,
            route_end: null,
          },
        })),
      ],
      occurrenceTypes,
      deliveredTypes,
      pauseTypes,
      journey: {
        pause_allowed: journey.routeId !== null,
        route_id: journey.routeId,
        day: journey.dayKey,
        time_zone: journey.timeZone,
      },
      settings,
    };
  }
}

export {
  ENDED_ROUTE_CHECKLIST_WINDOW_MS,
  ListMyDeliveriesUseCase,
  checklistsByRoute,
  routesOf,
};
export type { MyDeliveriesRoute };

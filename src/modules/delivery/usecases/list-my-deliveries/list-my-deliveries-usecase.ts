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

import { AppError } from "@/shared/errors/AppError";

interface ListMyDeliveriesRequest {
  userId: string;
  businessId: string;
  /** The clock. Only tests pass it. */
  now?: Date;
}

/** A route the list's open stops belong to, with the plan's version. */
interface MyDeliveriesRoute {
  id: string;
  code: number;
  plan_version: number;
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
}

/** The distinct routes of the deliveries' open stops, in first-seen order. */
function routesOf(deliveries: unknown[]): MyDeliveriesRoute[] {
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

    return {
      deliveries,
      routes: routesOf(deliveries),
      occurrenceTypes,
      deliveredTypes,
      pauseTypes,
      journey: {
        pause_allowed: journey.routeId !== null,
        route_id: journey.routeId,
        day: journey.dayKey,
        time_zone: journey.timeZone,
      },
    };
  }
}

export { ListMyDeliveriesUseCase, routesOf };
export type { MyDeliveriesRoute };

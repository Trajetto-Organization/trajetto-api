import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

interface AssignDeliveriesRequest {
  userId: string;
  businessId: string;
  deliveryIds: string[];
  driverId: string;
  vehicleId?: string | null;
}

interface AssignDeliveriesResult {
  assigned: number;

  /** The route the assignment created, so the client can open it. */
  routeId: string;
  routeCode: number;
}

/**
 * "Assign these twelve deliveries to João" — which is the same act as
 * "create a route for João with these twelve stops", and is now literally
 * that.
 *
 * It used to be its own writer. It set `Delivery.driverId` and
 * `Delivery.vehicleId` directly and created nothing else, and the
 * architecture plan is explicit that those columns are the route's shadow,
 * "escritos só pelo serviço de rota". Two writers of a shadow is how a shadow
 * drifts, but the drift was not the expensive part.
 *
 * The expensive part was that a delivery dispatched this way had no route,
 * and the product's evidence hangs off the route:
 *
 * - position recording refuses unless the driver has a route IN_PROGRESS, so
 *   a day's work assigned this way produced NO GPS trail at all — and the
 *   trail is what settles a dispute about where a truck was;
 * - the control tower reads routes, so the operation was invisible on the
 *   panel the dispatcher watches;
 * - `route.released` / `route.started` never fired, so nothing downstream —
 *   the customer's tracking page, a subscriber's ERP — learned that the load
 *   had left.
 *
 * None of that showed up as an error. The assignment succeeded, the driver
 * saw the documents, and the evidence simply did not exist.
 *
 * The route is created and RELEASED in one call, because that is what this
 * shortcut always meant: after assigning, the driver could see the work
 * immediately. A route born PLANNED would have made the shortcut stop working.
 */
@injectable()
class AssignDeliveriesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    /**
     * Named explicitly rather than left to `design:paramtypes`.
     *
     * tsyringe can infer a class dependency from emitted metadata, and here it
     * inferred `undefined` — the container built the use case with two missing
     * collaborators and the endpoint answered 500 on the first call. Nothing
     * in the unit suite could see it: those tests construct the class by hand.
     */
    @inject(CreateRouteUseCase)
    private createRoute: CreateRouteUseCase,
    @inject(ReleaseRouteUseCase)
    private releaseRoute: ReleaseRouteUseCase,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryIds,
    driverId,
    vehicleId,
  }: AssignDeliveriesRequest): Promise<AssignDeliveriesResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // One definition, shared: see assertDispatcher. Checked here as well as
    // inside `create-route` so the refusal happens before anything is
    // detached from a route below.
    assertDispatcher(findUser);

    /**
     * The vehicle is required now, and it was optional before.
     *
     * Releasing a route requires one, for a reason the product already
     * decided: discovering at the truck that no vehicle was assigned costs a
     * phone call and a morning. The old shortcut could hand a driver twelve
     * documents and no plate, and nothing anywhere said so.
     */
    if (!vehicleId) {
      throw new AppError(
        "Informe o veículo: a designação libera a rota para o motorista, e uma rota liberada precisa de veículo.",
        400,
        "ASSIGNMENT_VEHICLE_REQUIRED",
      );
    }

    // Duplicated ids in the selection are harmless — collapse them so the
    // count stays honest.
    const uniqueIds = [...new Set(deliveryIds)];

    /**
     * Reassignment, which is an ordinary morning: a driver calls in sick and
     * twelve documents move to somebody else.
     *
     * A delivery may hold only one open stop at a time — the database
     * enforces it — so moving one means releasing the stop it has. Only while
     * that route has not left: once it is IN_PROGRESS the stop records what
     * the driver is doing, and cancelling it silently would rewrite that.
     */
    const { blocked } = await this.route.detachFromOpenRoutes(
      uniqueIds,
      businessId,
    );

    if (blocked.length > 0) {
      throw new AppError(
        "Estas entregas já estão numa rota que saiu e não podem ser redesignadas: " +
          blocked.join(", "),
        409,
        "DELIVERY_ON_STARTED_ROUTE",
      );
    }

    /**
     * Everything else — the dispatcher guard, the driver being active, the
     * vehicle being in operation and belonging to the tenant, the deliveries
     * being routable — is `create-route`'s, and is deliberately NOT repeated
     * here. A second copy of those checks is a second thing to keep in step
     * with the first.
     */
    const created = await this.createRoute.execute({
      userId,
      businessId,
      driverId,
      vehicleId,
      name: assignmentRouteName(),
      scheduled_date: startOfToday(),
      deliveryIds: uniqueIds,
    });

    await this.releaseRoute.execute({
      userId,
      businessId,
      routeId: created.id,
    });

    return {
      assigned: created.stops.length,
      routeId: created.id,
      routeCode: created.code,
    };
  }
}

/**
 * A name a dispatcher can recognise in the route list a minute later.
 *
 * The shortcut does not ask for one — asking would make it no longer a
 * shortcut — so it says where the route came from and when.
 */
function assignmentRouteName(): string {
  const now = new Date();

  const date = now.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });

  const time = now.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `Designação ${date} ${time}`;
}

/** Today, at local midnight — the day the route is scheduled for. */
function startOfToday(): Date {
  const today = new Date();

  today.setHours(0, 0, 0, 0);

  return today;
}

export { AssignDeliveriesUseCase };

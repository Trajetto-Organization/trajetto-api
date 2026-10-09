import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";

import {
  CreateRouteUseCase,
  routeWriteFailure,
} from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";
import { UpdateRouteUseCase } from "@/modules/route/usecases/update-route/update-route-usecase";

import type { Route } from "@/modules/route/dtos/route-dto";
import { dateOnlyKey } from "@/shared/time/business-day";

import {
  RouteCodeTakenError,
  RouteStatusConflictError,
} from "@/modules/route/usecases/errors/route-errors";

import database from "@/../infra/database";

import { AppError } from "@/shared/errors/AppError";

import { assertRouteDispatcher } from "@/modules/route/usecases/shared/assert-route-dispatcher";
import { announcePlanChange } from "@/modules/route/usecases/shared/route-plan-change";

interface AssignDeliveriesRequest {
  userId: string;
  businessId: string;
  deliveryIds: string[];
  driverId: string;
  vehicleId?: string | null;

  /**
   * The plan of the route this creates (decision 6.5). The day defaults to
   * today in the company's zone; the window is checked against it there.
   */
  scheduled_date?: Date;
  destination?: string | null;
  planned_departure_at?: Date | null;
  planned_arrival_at?: Date | null;
}

/**
 * What the call did, so the answer can say it: a new released route, the
 * resend of one already released for this very selection (nothing written),
 * or that route edited with a corrected plan.
 */
type AssignmentOutcome = "created" | "resent" | "replanned";

interface AssignDeliveriesResult {
  assigned: number;

  /** The route the assignment created (or found), so the client can open it. */
  routeId: string;
  routeCode: number;

  outcome: AssignmentOutcome;
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
    @inject(CancelRouteUseCase)
    private cancelRoute: CancelRouteUseCase,
    @inject(UpdateRouteUseCase)
    private updateRoute: UpdateRouteUseCase,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryIds,
    driverId,
    vehicleId,
    scheduled_date,
    destination,
    planned_departure_at,
    planned_arrival_at,
  }: AssignDeliveriesRequest): Promise<AssignDeliveriesResult> {
    // The route module's guard, checked here as well as inside
    // `create-route` so the refusal happens before anything is detached
    // from a route below. A user deleted since the token check answers 401
    // AUTH_SESSION_INVALID, like every route write (it was a bare Error the
    // controller mapped to a 400 "Recurso não encontrado!").
    // Also the caller's company (defense in depth, not only the route guard).
    await assertRouteDispatcher(this.user, userId, businessId);

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
     * The resend of an assignment that already happened.
     *
     * The first call committed and its answer was lost; the dialog is still
     * open and the dispatcher confirms again. If these documents are exactly
     * what a released route of this same driver and truck holds, that route
     * IS the answer. Rebuilding it used to leave the first route released
     * with nothing on it and wake the driver with a second "rota liberada".
     */
    const { holder, blocked } = await this.route.inspectOpenStops(
      uniqueIds,
      businessId,
    );

    if (
      holder &&
      holder.status === "RELEASED" &&
      holder.driverId === driverId &&
      holder.vehicleId === vehicleId
    ) {
      /**
       * Same documents, driver and truck, but another plan: the dispatcher
       * corrected the day, the destination or a time and confirmed again.
       * That is an edit of the route already released, not a resend to
       * ignore — answering 200 without writing it lost the correction. The
       * edit goes through update-route, so its rules (the window on the
       * company's clock, against the stored values) and its activity line
       * are the same as on the Rotas screen.
       */
      const replanned = planChanges(holder, {
        scheduled_date,
        destination,
        planned_departure_at,
        planned_arrival_at,
      });

      if (replanned) {
        await this.updateRoute.execute({
          userId,
          businessId,
          routeId: holder.id,
          ...replanned,
        });
      }

      return {
        assigned: uniqueIds.length,
        routeId: holder.id,
        routeCode: holder.code,
        outcome: replanned ? "replanned" : "resent",
      };
    }

    // Asked before the checks below so it wins over their generic "only
    // pending deliveries" — a document on a truck that left is the more
    // useful thing to be told. The detach asks again, under lock.
    if (blocked.length > 0) throw onStartedRoute(blocked);

    const asked = {
      userId,
      businessId,
      driverId,
      vehicleId,
      scheduled_date,
      destination: destination ?? null,
      planned_departure_at: planned_departure_at ?? null,
      planned_arrival_at: planned_arrival_at ?? null,
      deliveryIds: uniqueIds,
    };

    /**
     * Every check BEFORE anything is written.
     *
     * The dispatcher guard, the driver being active, the vehicle being in
     * operation and belonging to the tenant, the deliveries being routable,
     * the plan's window on the company's clock — all `create-route`'s, and
     * deliberately not repeated here. They used to run after the detach had
     * already committed, so a refusal answered 400 over a previous route that
     * had lost its stops: the error said nothing changed, and the documents
     * were gone from the other driver's phone.
     */
    const validated = await this.createRoute.validate(asked);

    // The day and the label on the company's clock: the day used to be the
    // SERVER's midnight (UTC in the container), so from 21:00 in São Paulo
    // the shortcut scheduled tomorrow — and named it with a UTC hour.
    const request = {
      ...asked,
      scheduled_date: validated.scheduledDate,
      name: assignmentRouteName(new Date(), validated.timeZone),
    };

    /**
     * The detach, the new route and its release, as ONE unit of work — any
     * refusal from here on (a concurrent departure, a delivery cancelled in
     * the same instant, a code collision) rolls all of it back.
     */
    const unit = () =>
      database.$transaction(async (tx) => {
        /**
         * Reassignment, which is an ordinary morning: a driver calls in sick
         * and twelve documents move to somebody else.
         *
         * A delivery may hold only one open stop at a time — the database
         * enforces it — so moving one means releasing the stop it has. Only
         * while that route has not left: once it is IN_PROGRESS the stop
         * records what the driver is doing, and cancelling it silently would
         * rewrite that.
         */
        const detached = await this.route.detachFromOpenRoutes(
          uniqueIds,
          businessId,
          tx,
        );

        if (detached.blocked.length > 0) throw onStartedRoute(detached.blocked);

        const afterCommit: Array<() => Promise<void>> = [];
        const cancelledIds = new Set<string>();

        // A released route left with nothing on it is cancelled, and its
        // driver told — it was a promise to them that no longer means
        // anything. A PLANNED one is a draft nobody was told about, and the
        // dispatcher may still be filling it; it stays.
        for (const emptied of detached.emptiedRoutes) {
          if (emptied.status !== "RELEASED") continue;

          const { afterCommit: cancelled } = await this.cancelRoute.cancelWithin(
            tx,
            {
              userId,
              businessId,
              route: emptied,

              // The body of the push on that driver's lock screen. The same
              // shortcut also swaps only the truck, and then the documents
              // are still his, on the route released right below.
              reason:
                emptied.driverId === driverId
                  ? "Todas as paradas foram movidas para uma nova rota."
                  : "Todas as paradas foram redesignadas para outro motorista.",
            },
          );

          cancelledIds.add(emptied.id);
          afterCommit.push(cancelled);
        }

        // A source that kept other stops has a new plan (D5): its open page
        // and its driver (while released) are told. A cancelled one already
        // told everybody it is gone.
        for (const source of detached.bumped) {
          if (cancelledIds.has(source.routeId)) continue;

          afterCommit.push(() =>
            announcePlanChange(this.user, {
              businessId,
              routeId: source.routeId,
              routeCode: source.code,
              planVersion: source.planVersion,
              status: source.status,
              driverId: source.driverId,
            }),
          );
        }

        const created = await this.createRoute.buildWithin(
          tx,
          request,
          validated,
        );

        const { afterCommit: released } =
          await this.releaseRoute.transitionWithin(tx, {
            userId,
            businessId,
            route: created,
            released: true,
          });

        afterCommit.push(async () =>
          this.createRoute.recordCreated(created, request, validated),
        );
        afterCommit.push(released);

        return { created, afterCommit };
      });

    try {
      let outcome;

      try {
        outcome = await unit();
      } catch (error) {
        // Two dispatchers took the same route number in the same instant.
        // The whole unit runs again — an aborted transaction cannot be
        // continued — and the second read picks the next number.
        if (!(error instanceof RouteCodeTakenError)) throw error;

        outcome = await unit();
      }

      for (const run of outcome.afterCommit) await run();

      return {
        assigned: outcome.created.stops.length,
        routeId: outcome.created.id,
        routeCode: outcome.created.code,
        outcome: "created",
      };
    } catch (error) {
      // The route moved between the read and the write (a departure, a
      // cancellation): nothing was written, and the screen has to refresh.
      if (error instanceof RouteStatusConflictError) {
        throw new AppError(error.message, 409, "ROUTE_STATUS_CONFLICT");
      }

      throw routeWriteFailure(
        error,
        "Houve um erro ao tentar designar as entregas! Por favor, tente novamente.",
      );
    }
  }
}

interface AssignedPlan {
  scheduled_date?: Date;
  destination?: string | null;
  planned_departure_at?: Date | null;
  planned_arrival_at?: Date | null;
}

const sameInstant = (a: Date | null, b: Date | null): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * The plan fields the request SENT that differ from the route's, or null
 * when nothing differs. An absent field is "not said" and never an edit: a
 * resend without a day after midnight must not move the route to the new
 * "today".
 */
function planChanges(route: Route, asked: AssignedPlan): AssignedPlan | null {
  const changes: AssignedPlan = {};

  if (
    asked.scheduled_date !== undefined &&
    dateOnlyKey(asked.scheduled_date) !== dateOnlyKey(route.scheduled_date)
  ) {
    changes.scheduled_date = asked.scheduled_date;
  }

  if (
    asked.destination !== undefined &&
    (asked.destination ?? null) !== (route.destination ?? null)
  ) {
    changes.destination = asked.destination;
  }

  if (
    asked.planned_departure_at !== undefined &&
    !sameInstant(asked.planned_departure_at, route.planned_departure_at)
  ) {
    changes.planned_departure_at = asked.planned_departure_at;
  }

  if (
    asked.planned_arrival_at !== undefined &&
    !sameInstant(asked.planned_arrival_at, route.planned_arrival_at)
  ) {
    changes.planned_arrival_at = asked.planned_arrival_at;
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

/** The deliveries are on a route that already left, named for the dispatcher. */
function onStartedRoute(blocked: string[]): AppError {
  return new AppError(
    "Estas entregas já estão numa rota que saiu e não podem ser redesignadas: " +
      blocked.join(", "),
    409,
    "DELIVERY_ON_STARTED_ROUTE",
  );
}

/**
 * A name a dispatcher can recognise in the route list a minute later.
 *
 * The shortcut does not ask for one — asking would make it no longer a
 * shortcut — so it says where the route came from and when, on the
 * company's clock (the process runs in UTC).
 */
function assignmentRouteName(now: Date, timeZone: string): string {
  const date = now.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
  });

  const time = now.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });

  return `Designação ${date} ${time}`;
}

/**
 * The sentence the dialog's toast shows, saying what actually happened: a
 * resend or a corrected plan used to read "criada e liberada" over a route
 * that was neither created nor released by that call.
 */
function assignmentMessage({
  outcome,
  routeCode,
  assigned,
}: Pick<AssignDeliveriesResult, "outcome" | "routeCode" | "assigned">): string {
  const deliveries = `${assigned} entrega${assigned === 1 ? "" : "s"}`;

  if (outcome === "replanned") {
    return `Rota ${routeCode} atualizada com o novo planejamento (${deliveries}).`;
  }

  if (outcome === "resent") {
    return `Rota ${routeCode} já estava criada e liberada com ${deliveries}; nada foi alterado.`;
  }

  return `Rota ${routeCode} criada e liberada com ${deliveries}.`;
}

export {
  AssignDeliveriesUseCase,
  assignmentMessage,
  assignmentRouteName,
  planChanges,
};
export type { AssignDeliveriesResult, AssignmentOutcome };

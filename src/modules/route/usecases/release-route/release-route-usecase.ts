import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import database from "@/../infra/database";
import {
  sendRouteEventToBusiness,
  sendRouteEventToDriver,
} from "@/websocket";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { routeEventPayload } from "@/shared/integration/announce";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";
import { assertDriverStillActive } from "../shared/driver-still-active";
import {
  assertPlanVersion,
  planWriteFailure,
} from "../shared/route-plan-change";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import {
  canReleaseRoute,
  canTransitionRoute,
  canUnreleaseRoute,
} from "@/shared/route/route-rules";
import { routeDayLabel } from "@/shared/route/route-plan-rules";

import {
  RouteNotFoundError,
  RouteStatusConflictError,
} from "../errors/route-errors";

import type { Prisma } from "@prisma/client";

import type { Route, RouteWithStops } from "../../dtos/route-dto";

interface ReleaseRouteRequest {
  userId: string;
  businessId: string;
  routeId: string;

  /** false pulls a released route back to planning, for editing. */
  released?: boolean;

  /**
   * The plan the dispatcher is releasing (decision 14.7, D5): a colleague's
   * change in between is 409 ROUTE_PLAN_STALE, not a plan nobody reviewed
   * landing on a driver's phone.
   */
  expectedPlanVersion?: number;
}

interface ReleaseRouteResult {
  route: Route;

  /** Already in the asked state: a double click or a retry, nothing written. */
  unchanged: boolean;
}

/**
 * Hands a route to its driver, or pulls it back.
 *
 * Releasing is the moment the route stops being a draft: from here the driver
 * sees it in the app and can leave with it. That is why the vehicle is
 * required one step earlier than the departure strictly needs it — discovering
 * at the truck that no vehicle was assigned costs a phone call and a morning.
 */
@injectable()
class ReleaseRouteUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    released = true,
    expectedPlanVersion,
  }: ReleaseRouteRequest): Promise<ReleaseRouteResult> {
    // Planning is the dispatcher's job, and `delivery_manage` is open to
    // drivers so the app's own surface works — so the permission says yes
    // and this says no.
    await assertRouteDispatcher(this.user, userId, businessId);

    const findRoute = await this.route.findRouteById(routeId, businessId);

    // The read is already scoped by business, so a route of another company
    // is indistinguishable from one that does not exist — which is the point.
    // A different refusal for "exists but is not yours" tells a caller which
    // ids are real.
    if (!findRoute) throw new RouteNotFoundError();

    const target = released ? "RELEASED" : "PLANNED";

    // The state it is already in: the second click, or a retry after a lost
    // answer. 200 with nothing written, instead of the 400 the state machine
    // gives a same-state move (decision 14.7, §4.8).
    if (findRoute.status === target) {
      return { route: findRoute, unchanged: true };
    }

    const verdict = canTransitionRoute(findRoute.status, target);

    if (!verdict.allowed) {
      throw new AppError(verdict.reason!, 400, "INVALID_ROUTE_TRANSITION");
    }

    if (released) {
      const findDriver = await this.driver.findDriverById(findRoute.driverId);

      const readiness = canReleaseRoute({
        stopCount: findRoute.stops.length,
        hasVehicle: Boolean(findRoute.vehicleId),
        isDriverActive: findDriver?.status === "ACTIVE",
      });

      if (!readiness.allowed) {
        throw new AppError(readiness.reason!, 400, "ROUTE_NOT_RELEASABLE");
      }
    } else {
      // Pulling back is only legal while nothing was executed. Once a stop has
      // been worked, the route is a record of what the driver did, and editing
      // it would rewrite that.
      const reversible = canUnreleaseRoute(
        findRoute.stops.map((stop) => stop.status),
      );

      if (!reversible.allowed) {
        throw new AppError(reversible.reason!, 400, "ROUTE_ALREADY_STARTED");
      }
    }

    try {
      // The write and the push land together. Published with the transaction
      // rather than after it, because the event has to exist if and only if
      // the release committed — the alternative is a driver whose phone says
      // the route is theirs over a write that rolled back.
      const { updated, afterCommit } = await database.$transaction(async (tx) => {
        if (expectedPlanVersion !== undefined) {
          // Locked, then read: an add-stops committing in between is waited
          // for and then seen, never released unseen.
          await this.route.lockRoutes([routeId], businessId, tx);

          const current = await this.route.findRouteById(routeId, businessId, tx);

          assertPlanVersion(current?.plan_version ?? 0, expectedPlanVersion);
        }

        return this.transitionWithin(tx, {
          userId,
          businessId,
          route: findRoute,
          released,
        });
      });

      await afterCommit();

      return { route: updated, unchanged: false };
    } catch (error) {
      const planFailure = planWriteFailure(error);

      if (planFailure) throw planFailure;

      if (error instanceof RouteStatusConflictError) {
        throw new AppError(error.message, 409, "ROUTE_STATUS_CONFLICT");
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar liberar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }

  /**
   * The move and everything that must commit with it — the push to the
   * driver (outbox) and the integration event — inside the caller's
   * transaction. What may only happen AFTER the commit (sockets, activity)
   * comes back as `afterCommit`, for the caller to run once it has committed.
   *
   * Split out for the batch assignment, which builds and releases a route in
   * the same unit of work as detaching the deliveries from their previous
   * one. The readiness checks stay in `execute`; a caller of this has made
   * them already.
   */
  async transitionWithin(
    tx: Prisma.TransactionClient,
    {
      userId,
      businessId,
      route,
      released,
    }: {
      userId: string;
      businessId: string;
      route: RouteWithStops;
      released: boolean;
    },
  ): Promise<{ updated: Route; afterCommit: () => Promise<void> }> {
    const routeId = route.id;
    const target = released ? "RELEASED" : "PLANNED";

    // The handover re-reads the driver under the row's lock: `execute`
    // checked the status before this transaction, and a deactivation that
    // committed since must not hand the route to an inactive driver.
    if (released) {
      await assertDriverStillActive(this.route, tx, {
        driverId: route.driverId,
        businessId,
        refusal: {
          message: "Só é possível liberar uma rota para um motorista ativo.",
          code: "ROUTE_NOT_RELEASABLE",
        },
      });
    }

    const updated = await this.route.transitionRoute(
      routeId,
      businessId,
      { expectedStatus: route.status, status: target },
      tx,
    );

    // Only the handover rings. Pulling a route BACK to planning is a
    // correction of something the driver has not started, and a push saying
    // "never mind" about work they had not looked at yet is noise.
    if (released) {
      const driverUser = await this.user.findUserByDriverId(route.driverId);

      await this.outbox.publish(tx, {
        topic: "route.released",
        aggregateType: "route",
        aggregateId: routeId,
        businessId,
        actorId: userId,
        payload: {
          routeId,
          businessId,
          driverUserId: driverUser?.id ?? null,
          code: route.code,
          routeName: route.name,
          stopCount: route.stops.length,
          // In UTC: the day is a date-only value (decision 1.3).
          scheduledLabel: routeDayLabel(route.scheduled_date),
        },
      });
    }

    // In the SAME transaction as the release, for the reason the outbox row
    // above is: an event queued after the commit is an event a crash in
    // between erases.
    //
    // And the topic follows `released`, not the endpoint's name. This use case
    // also pulls a route BACK to planning, and announcing `route.released` for
    // that would tell an ERP to dispatch a load that just came off the street
    // — the payload said "RELEASED" while the row said "PLANNED".
    await this.webhooks.announce(
      released ? "route.released" : "route.unreleased",
      businessId,
      routeEventPayload({ ...route, status: target }),
      tx,
    );

    const afterCommit = async (): Promise<void> => {
      // After the commit, never inside it: an event about a write that rolled
      // back is a lie the client cannot undo. The push (outbox) reaches a
      // phone in a pocket; this reaches an app that is open right now.
      if (released) {
        const driverUser = await this.user.findUserByDriverId(route.driverId);

        sendRouteEventToDriver(driverUser?.id ?? null, {
          type: "route.released",
          routeId,
          routeCode: route.code,
        });
      }

      /**
       * And the dispatcher's board, which was the one surface this never
       * reached.
       *
       * `start-route` and `cancel-route` have announced to the company since
       * they existed; the release did not, so the moment a route stopped
       * being a draft — arguably the one the board cares about most — was
       * visible only to the driver and to a webhook subscriber. A dispatcher
       * with the Rotas tab open saw PLANNED until they pressed Atualizar.
       *
       * Both directions, because pulling a route back to planning takes it
       * off the driver's phone and the board has to say so.
       */
      sendRouteEventToBusiness(businessId, {
        type: released ? "route.released" : "route.unreleased",
        routeId,
        routeCode: route.code,
      });

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description: released
          ? `Rota ${route.code} liberada para o motorista`
          : `Rota ${route.code} devolvida ao planejamento`,
        status: released ? "Liberada" : "Planejada",
        performedBy: userId,
        businessId,
      });
    };

    return { updated, afterCommit };
  }
}

export { ReleaseRouteUseCase };
export type { ReleaseRouteRequest, ReleaseRouteResult };

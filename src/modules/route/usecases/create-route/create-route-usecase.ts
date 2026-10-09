import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import database from "@/../infra/database";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import { NotificationService } from "@/shared/services/notification-service";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { deliveryAssignedPayload } from "@/shared/integration/announce";

import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";
import { isVehicleOutOfOperation } from "@/shared/vehicle/vehicle-rules";

import { assertDeliveriesRoutable } from "../shared/routable-deliveries";
import { assertRoutePlan } from "../shared/route-plan";
import { assertDriverStillActive } from "../shared/driver-still-active";

import { businessToday } from "@/shared/time/business-day";
import { isUniqueViolation } from "@/shared/http/idempotency-key";

import {
  DeliveryAlreadyOnRouteError,
  DeliveryNoLongerRoutableError,
  RouteCodeTakenError,
  RouteDriverInactiveError,
  RouteVehicleUnavailableError,
} from "../errors/route-errors";

import type { Prisma } from "@prisma/client";

import type { RouteWithStops } from "../../dtos/route-dto";

/** What `validate` found, handed to the write so nothing is read twice. */
interface ValidatedRoute {
  driverName: string;
  vehicleLabel: string | null;
  uniqueIds: string[];
  routed: Awaited<ReturnType<IDeliveryRepository["findDeliveriesByIds"]>>;

  /** The company's zone (Business.timezone), the one the plan was read in. */
  timeZone: string;

  /** The route's day: the one asked for, or today in the company's zone. */
  scheduledDate: Date;
}

interface CreateRouteRequest {
  userId: string;
  businessId: string;

  driverId: string;
  vehicleId?: string | null;

  name?: string | null;

  /**
   * The route's day (date-only). Absent means today in the company's zone —
   * what the batch assignment wants when the dialog does not say.
   */
  scheduled_date?: Date;
  destination?: string | null;

  planned_departure_at?: Date | null;
  planned_arrival_at?: Date | null;

  deliveryIds?: string[];

  /**
   * The panel's Idempotency-Key (decision 14.7, §4.7). A resend of the same
   * key answers the route the first call made, with nothing written again.
   */
  client_submission_id?: string;
}

/**
 * Builds a day's work for one driver.
 *
 * This is also what the batch assignment became: "assign these twelve
 * deliveries to João" is the same act as "create a route for João with these
 * twelve stops", and having it be one code path is what keeps
 * `Delivery.driverId` honest — those columns are the route's shadow, and a
 * second writer is how a shadow drifts.
 *
 * The route is born PLANNED. Nothing reaches the driver until it is released.
 */
@injectable()
class CreateRouteUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute(
    request: CreateRouteRequest,
  ): Promise<RouteWithStops & { replayed?: boolean }> {
    const replay = await this.replayOf(request);

    if (replay) return replay;

    const validated = await this.validate(request);

    /**
     * The route and every event it announces, in ONE unit of work.
     *
     * Forty documents changing hands is forty events, and a loop that runs
     * after the commit is not all-or-nothing: a crash halfway leaves a
     * subscriber's ERP holding twenty of the forty with no way to learn about
     * the rest. Every other write in this module already holds that rule; the
     * `delivery.assigned` announcement had to join it.
     */
    const build = () =>
      database.$transaction((tx) => this.buildWithin(tx, request, validated));

    try {
      let created: RouteWithStops | undefined;

      // The code is allocated under a per-company lock (nextCode), so a
      // collision should not happen; if one still does, the whole unit runs
      // again a few times, and the last one answers 409 rather than 500.
      for (let attempt = 1; created === undefined; attempt += 1) {
        try {
          created = await build();
        } catch (error) {
          if (!(error instanceof RouteCodeTakenError)) throw error;

          if (attempt >= CODE_ATTEMPTS) {
            logger.warn(
              { businessId: request.businessId, attempts: attempt },
              "route code still taken after retries",
            );

            throw new AppError(error.message, 409, "ROUTE_CODE_TAKEN");
          }
        }
      }

      this.recordCreated(created, request, validated);

      return created;
    } catch (error) {
      // The twin of this submission committed between the replay check and
      // the insert: the index refused this one, and the twin is the answer.
      if (request.client_submission_id && isUniqueViolation(error)) {
        const twin = await this.replayOf(request);

        if (twin) return twin;
      }

      throw routeWriteFailure(
        error,
        "Houve um erro ao tentar criar a rota! Por favor, tente novamente.",
      );
    }
  }

  /**
   * The route an earlier call with the same Idempotency-Key made, for the
   * same company — answered as the result, flagged `replayed`, with no new
   * `delivery.assigned` and no activity line. A key used by another company
   * finds nothing here (the index is per company) and creates its own.
   */
  private async replayOf(
    request: CreateRouteRequest,
  ): Promise<(RouteWithStops & { replayed: true }) | null> {
    if (!request.client_submission_id) return null;

    // The dispatcher guard first: a replay must not answer a driver token.
    await assertRouteDispatcher(this.user, request.userId, request.businessId);

    const found = await this.route.findRouteBySubmission(
      request.businessId,
      request.client_submission_id,
    );

    return found ? { ...found, replayed: true } : null;
  }

  /**
   * Every check a new route needs, and no write.
   *
   * Split out so the batch assignment can run all of them BEFORE it touches
   * the route the deliveries are on now. It used to detach first and let
   * `execute` refuse afterwards — a 400 to the dispatcher over a previous
   * route that had already lost its stops.
   */
  async validate({
    userId,
    businessId,
    driverId,
    vehicleId,
    scheduled_date,
    planned_departure_at,
    planned_arrival_at,
    deliveryIds = [],
  }: CreateRouteRequest): Promise<ValidatedRoute> {
    // Planning is the dispatcher's job, and `delivery_manage` is open to
    // drivers so the app's own surface works — so the permission says yes
    // and this says no.
    await assertRouteDispatcher(this.user, userId, businessId);

    const findDriver = await this.driver.findDriverById(driverId);

    if (!findDriver || findDriver.businessId !== businessId) {
      throw new AppError("Motorista não encontrado.", 404, "DRIVER_NOT_FOUND");
    }

    if (findDriver.status !== "ACTIVE") {
      throw new AppError(
        new RouteDriverInactiveError().message,
        400,
        "ROUTE_DRIVER_INACTIVE",
      );
    }

    let vehicleLabel: string | null = null;

    if (vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(vehicleId);

      if (!findVehicle || findVehicle.businessId !== businessId) {
        throw new AppError("Veículo não encontrado.", 404, "VEHICLE_NOT_FOUND");
      }

      // IN_ROUTE stays selectable here: tomorrow's route is planned while
      // today's is still on the street. What is refused is the DEPARTURE of a
      // second route on the same vehicle, enforced in the database.
      if (isVehicleOutOfOperation(findVehicle.status)) {
        throw new AppError(
          new RouteVehicleUnavailableError().message,
          400,
          "ROUTE_VEHICLE_UNAVAILABLE",
        );
      }

      vehicleLabel = findVehicle.license_plate;
    }

    // Duplicates in the selection are harmless — collapse them so the count
    // checks below stay honest.
    const uniqueIds = [...new Set(deliveryIds)];

    let routed: Awaited<
      ReturnType<IDeliveryRepository["findDeliveriesByIds"]>
    > = [];

    if (uniqueIds.length > 0) {
      routed = await this.delivery.findDeliveriesByIds(uniqueIds);

      // Shared with add-route-stops: the same question at two moments, and two
      // copies of it would drift the first time one learned a new status.
      assertDeliveriesRoutable(routed, uniqueIds, businessId);
    }

    // The window is read on the company's clock: the departure has to fall
    // on the route's day THERE, which zod cannot know (decision 6.5).
    const timeZone = await this.route.businessTimeZone(businessId);
    const scheduledDate = scheduled_date ?? businessToday(timeZone);

    assertRoutePlan({
      scheduledDate,
      departure: planned_departure_at,
      arrival: planned_arrival_at,
      timeZone,
    });

    return {
      driverName: findDriver.name,
      vehicleLabel,
      uniqueIds,
      routed,
      timeZone,
      scheduledDate,
    };
  }

  /**
   * The route and its `delivery.assigned` events, inside the caller's
   * transaction. The caller owns the commit, and with it the retry on
   * RouteCodeTakenError (an aborted transaction cannot be continued).
   */
  async buildWithin(
    tx: Prisma.TransactionClient,
    request: CreateRouteRequest,
    { uniqueIds, routed, scheduledDate }: ValidatedRoute,
  ): Promise<RouteWithStops> {
    const {
      businessId,
      driverId,
      vehicleId,
      name,
      destination,
      planned_departure_at,
      planned_arrival_at,
      client_submission_id,
    } = request;

    // `validate` read the status before the transaction; a deactivation
    // committing since then is seen here, under the driver row's lock.
    await assertDriverStillActive(this.route, tx, {
      driverId,
      businessId,
      refusal: {
        message: new RouteDriverInactiveError().message,
        code: "ROUTE_DRIVER_INACTIVE",
      },
    });

    const route = await this.route.createRoute(
      {
        businessId,
        driverId,
        vehicleId: vehicleId ?? null,
        name: name ?? null,
        scheduled_date: scheduledDate,
        destination: destination ?? null,
        planned_departure_at: planned_departure_at ?? null,
        planned_arrival_at: planned_arrival_at ?? null,
        deliveryIds: uniqueIds,
        client_submission_id: client_submission_id ?? null,
      },
      tx,
    );

    /**
     * One `delivery.assigned` per document, not one for the route.
     *
     * A subscriber matches on a DELIVERY — an ERP wants to know that order
     * 4477 now has a driver — and an event carrying forty ids is an event
     * every subscriber has to unpack before it can act.
     *
     * It used to be announced by the batch-assignment use case, which meant a
     * subscriber heard about an assignment only when the dispatcher took the
     * shortcut: building the same route on the Rotas screen announced nothing.
     * Both paths come through here now. Adding stops to a route and changing
     * a route's driver or vehicle announce the same event, with the same
     * shape (deliveryAssignedPayload).
     */
    // The timeline line each delivery gets when it joins a plan, as
    // add-stops writes it (decision 14.7): the planning history of a
    // document does not depend on which screen built the route.
    await this.route.recordPlanEvents(
      tx,
      uniqueIds.map((deliveryId, index) => ({
        deliveryId,
        note: `Adicionada à Rota ${route.code} (parada ${index + 1}).`,
      })),
      {
        type: "ROUTE_ADDED",
        routeId: route.id,
        businessId,
        actorId: request.userId,
      },
    );

    for (const delivery of routed) {
      await this.webhooks.announce(
        "delivery.assigned",
        businessId,
        deliveryAssignedPayload(
          { ...delivery, id: delivery.id! },
          {
            id: route.id,
            code: route.code,
            driverId,
            vehicleId: vehicleId ?? null,
          },
        ),
        tx,
      );
    }

    return route;
  }

  /** The activity line, after the commit — never about a write that rolled back. */
  recordCreated(
    created: RouteWithStops,
    { userId, businessId }: CreateRouteRequest,
    { driverName, vehicleLabel, uniqueIds }: ValidatedRoute,
  ): void {
    this.notificationService.createActivityIfEnabled({
      type: "Rota",
      action: "create",
      entityId: created.id,
      description:
        `Rota ${created.code} criada para ${driverName} com ` +
        `${uniqueIds.length} parada${uniqueIds.length === 1 ? "" : "s"}` +
        (vehicleLabel ? ` (veículo ${vehicleLabel})` : ""),
      status: "Planejada",
      performedBy: userId,
      businessId,
    });
  }
}

/**
 * What a failed route write means to the caller. Shared with the batch
 * assignment, which builds the route inside its own transaction and has to
 * answer the same refusals the same way.
 */
function routeWriteFailure(error: unknown, fallback: string): AppError {
  // 409, not 400: the request was well formed and the caller was allowed
  // to make it — somebody else put one of these deliveries on a route
  // first. The screen has to say "refresh", not "you did it wrong".
  if (error instanceof DeliveryAlreadyOnRouteError) {
    return new AppError(error.message, 409, "DELIVERY_ALREADY_ON_ROUTE");
  }

  // Cancelled (or sent out by hand) between the check and the write: the
  // same refusal as the check, as a 409 — "refresh", not "you did it wrong".
  if (error instanceof DeliveryNoLongerRoutableError) {
    return new AppError(error.message, 409, "DELIVERY_NOT_ROUTABLE");
  }

  if (error instanceof AppError) return error;

  // The cause of a 500 was never recorded: log it before it is masked.
  logger.error({ err: error }, "route write failed");

  return new AppError(fallback, 500);
}

/** Runs of the create unit before a code collision becomes a 409. */
const CODE_ATTEMPTS = 3;

export { CreateRouteUseCase, routeWriteFailure };
export type { CreateRouteRequest, ValidatedRoute };

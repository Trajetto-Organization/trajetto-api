import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import database from "@/../infra/database";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { deliveryAssignedPayload } from "@/shared/integration/announce";

import { isVehicleOutOfOperation } from "@/shared/vehicle/vehicle-rules";
import { ROUTE_STATUS_LABELS, isStopOpen } from "@/shared/route/route-rules";

import { assertRoutePlan } from "../shared/route-plan";
import { assertDriverStillActive } from "../shared/driver-still-active";
import {
  announcePlanChange,
  planWriteFailure,
} from "../shared/route-plan-change";

import {
  RouteDriverInactiveError,
  RouteNotFoundError,
  RouteStatusConflictError,
  RouteVehicleUnavailableError,
} from "../errors/route-errors";

import type { Route } from "../../dtos/route-dto";

interface UpdateRouteRequest {
  userId: string;
  businessId: string;
  routeId: string;

  name?: string | null;
  scheduled_date?: Date;
  destination?: string | null;

  planned_departure_at?: Date | null;
  planned_arrival_at?: Date | null;

  driverId?: string;
  vehicleId?: string | null;

  /** The plan the dispatcher is looking at (decision 14.7, D5). */
  expectedPlanVersion?: number;
}

/** Only a route that has not been executed may be edited. */
const EDITABLE = new Set(["PLANNED", "RELEASED"]);

/**
 * Edits the plan: name, day, windows, driver, vehicle.
 *
 * Not a status change — those go through release / start / cancel. What this
 * shares with them is the discipline: the tenant and the state are checked
 * here for a good error message, and carried into the `where` so the write
 * itself cannot land on a route of another company or on one that has already
 * run.
 *
 * Changing the driver or the vehicle also moves the shadow on the deliveries,
 * which is why that happens inside the repository rather than here: those
 * columns have exactly one writer.
 */
@injectable()
class UpdateRouteUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    driverId,
    vehicleId,
    expectedPlanVersion,
    ...fields
  }: UpdateRouteRequest): Promise<Route> {
    // Planning is the dispatcher's job, and `delivery_manage` is open to
    // drivers so the app's own surface works — so the permission says yes
    // and this says no.
    await assertRouteDispatcher(this.user, userId, businessId);

    const findRoute = await this.route.findRouteById(routeId, businessId);

    // Scoped read: another company's route reads as absent.
    if (!findRoute) throw new RouteNotFoundError();

    if (!EDITABLE.has(findRoute.status)) {
      throw new AppError(
        "Esta rota já foi executada e não pode mais ser editada. " +
          "Cancele-a se precisar refazê-la.",
        400,
        "ROUTE_NOT_EDITABLE",
      );
    }

    if (driverId && driverId !== findRoute.driverId) {
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
    }

    if (vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(vehicleId);

      if (!findVehicle || findVehicle.businessId !== businessId) {
        throw new AppError("Veículo não encontrado.", 404, "VEHICLE_NOT_FOUND");
      }

      if (isVehicleOutOfOperation(findVehicle.status)) {
        throw new AppError(
          new RouteVehicleUnavailableError().message,
          400,
          "ROUTE_VEHICLE_UNAVAILABLE",
        );
      }
    }

    /**
     * The window, checked as it WILL be: a partial edit that moves only the
     * day (or only one end) is judged against the stored values of the
     * rest — the zod layer sees just the body and cannot. Only when the edit
     * touches the plan, so renaming a route whose stored window predates the
     * rule is not refused for something the edit did not change.
     */
    if (
      fields.scheduled_date !== undefined ||
      fields.planned_departure_at !== undefined ||
      fields.planned_arrival_at !== undefined
    ) {
      assertRoutePlan({
        scheduledDate: fields.scheduled_date ?? findRoute.scheduled_date,
        departure:
          fields.planned_departure_at !== undefined
            ? fields.planned_departure_at
            : findRoute.planned_departure_at,
        arrival:
          fields.planned_arrival_at !== undefined
            ? fields.planned_arrival_at
            : findRoute.planned_arrival_at,
        timeZone: await this.route.businessTimeZone(businessId),
      });
    }

    // Who holds the route's deliveries changes only with these two.
    const reassigned =
      (driverId !== undefined && driverId !== findRoute.driverId) ||
      (vehicleId !== undefined && vehicleId !== findRoute.vehicleId);

    try {
      const updated = await database.$transaction(async (tx) => {
        // A new driver is re-read under the row's lock: a deactivation that
        // committed after the check above must not receive this route.
        if (driverId !== undefined && driverId !== findRoute.driverId) {
          await assertDriverStillActive(this.route, tx, {
            driverId,
            businessId,
            refusal: {
              message: new RouteDriverInactiveError().message,
              code: "ROUTE_DRIVER_INACTIVE",
            },
          });
        }

        const route = await this.route.updateRoute(
          routeId,
          businessId,
          {
            ...fields,
            ...(driverId !== undefined && { driverId }),
            ...(vehicleId !== undefined && { vehicleId }),
          },
          tx,
          { expectedPlanVersion },
        );

        /**
         * A new driver or vehicle is a new `delivery.assigned` for every
         * stop still open — the repository just moved them to it. Swapping
         * the driver of a planned route used to be silent, and an ERP kept
         * telling its customer somebody else was coming.
         *
         * Read back inside the transaction: the update holds the route row,
         * so no stop can be added or removed until this commits, and the
         * stops announced are exactly the ones that changed hands.
         */
        if (reassigned) {
          const current = await this.route.findRouteById(
            routeId,
            businessId,
            tx,
          );

          for (const stop of current?.stops ?? []) {
            if (!isStopOpen(stop.status)) continue;

            await this.webhooks.announce(
              "delivery.assigned",
              businessId,
              deliveryAssignedPayload(stop.delivery, route),
              tx,
            );
          }
        }

        return route;
      });

      // The crew or the window is part of the plan the driver follows.
      await announcePlanChange(this.user, {
        businessId,
        routeId,
        routeCode: updated.code,
        planVersion: updated.plan_version,
        status: updated.status,
        driverId: updated.driverId,
      });

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description: `Rota ${findRoute.code} editada`,
        // The label, never the enum: the Activities list shows this column
        // as it is stored, and "PLANNED" is what the screen used to read.
        status: ROUTE_STATUS_LABELS[updated.status],
        performedBy: userId,
        businessId,
      });

      return updated;
    } catch (error) {
      const planFailure = planWriteFailure(error);

      if (planFailure) throw planFailure;

      // The route moved between the read and the write — released, started or
      // cancelled by somebody else while this form was open.
      if (error instanceof RouteStatusConflictError) {
        throw new AppError(error.message, 409, "ROUTE_STATUS_CONFLICT");
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar editar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateRouteUseCase };
export type { UpdateRouteRequest };

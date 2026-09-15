import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { isVehicleOutOfOperation } from "@/shared/vehicle/vehicle-rules";

import { assertDeliveriesRoutable } from "../shared/routable-deliveries";

import {
  DeliveryAlreadyOnRouteError,
  RouteDriverInactiveError,
  RouteVehicleUnavailableError,
} from "../errors/route-errors";

import type { RouteWithStops } from "../../dtos/route-dto";

interface CreateRouteRequest {
  userId: string;
  businessId: string;

  driverId: string;
  vehicleId?: string | null;

  name?: string | null;
  scheduled_date: Date;

  planned_departure_at?: Date | null;
  planned_arrival_at?: Date | null;

  deliveryIds?: string[];
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
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    businessId,
    driverId,
    vehicleId,
    name,
    scheduled_date,
    planned_departure_at,
    planned_arrival_at,
    deliveryIds = [],
  }: CreateRouteRequest): Promise<RouteWithStops> {
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

    if (uniqueIds.length > 0) {
      const deliveries = await this.delivery.findDeliveriesByIds(uniqueIds);

      // Shared with add-route-stops: the same question at two moments, and two
      // copies of it would drift the first time one learned a new status.
      assertDeliveriesRoutable(deliveries, uniqueIds, businessId);
    }

    try {
      const created = await this.route.createRoute({
        businessId,
        driverId,
        vehicleId: vehicleId ?? null,
        name: name ?? null,
        scheduled_date,
        planned_departure_at: planned_departure_at ?? null,
        planned_arrival_at: planned_arrival_at ?? null,
        deliveryIds: uniqueIds,
      });

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "create",
        entityId: created.id,
        description:
          `Rota ${created.code} criada para ${findDriver.name} com ` +
          `${uniqueIds.length} parada${uniqueIds.length === 1 ? "" : "s"}` +
          (vehicleLabel ? ` (veículo ${vehicleLabel})` : ""),
        status: "Planejada",
        performedBy: userId,
        businessId,
      });

      return created;
    } catch (error) {
      // 409, not 400: the request was well formed and the caller was allowed
      // to make it — somebody else put one of these deliveries on a route
      // first. The screen has to say "refresh", not "you did it wrong".
      if (error instanceof DeliveryAlreadyOnRouteError) {
        throw new AppError(error.message, 409, "DELIVERY_ALREADY_ON_ROUTE");
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar criar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateRouteUseCase };
export type { CreateRouteRequest };

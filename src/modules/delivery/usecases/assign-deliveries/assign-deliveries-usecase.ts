import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
  DeliveryNotAssignableError,
  DeliveryDriverInactiveError,
  DeliveryVehicleUnavailableError,
  DeliveryAssignmentConflictError,
} from "../errors/delivery-errors";

import { AppError } from "@/shared/errors/AppError";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { deliveryEventPayload } from "@/shared/integration/announce";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { isVehicleOutOfOperation } from "@/shared/vehicle/vehicle-rules";

interface AssignDeliveriesRequest {
  userId: string;
  businessId: string;
  deliveryIds: string[];
  driverId: string;
  vehicleId?: string | null;
}

interface AssignDeliveriesResult {
  assigned: number;
}

/**
 * Batch assignment over PENDING deliveries, all-or-nothing.
 *
 * Assigning does not touch the status machine: a PENDING delivery with a
 * driver is presented as "Designada" (derived state) and only the driver
 * moves it to IN_TRANSIT by starting the route in the app. Reassigning a
 * designated delivery overwrites the pair — an omitted vehicle clears the
 * previous one rather than lingering.
 */
@injectable()
class AssignDeliveriesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
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

    // One definition, shared: see assertDispatcher.
    assertDispatcher(findUser);

    const findDriver = await this.driver.findDriverById(driverId);

    if (!findDriver) {
      throw new DriverNotFoundError();
    }

    if (findDriver.businessId !== businessId) {
      throw new DriverNotBelongBusinessError();
    }

    if (findDriver.status !== "ACTIVE") {
      throw new DeliveryDriverInactiveError();
    }

    let vehicleLabel: string | null = null;

    if (vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(vehicleId);

      if (!findVehicle) {
        throw new VehicleNotFoundError();
      }

      if (findVehicle.businessId !== businessId) {
        throw new VehicleNotBelongBusinessError();
      }

      // IN_ROUTE stays assignable: tomorrow's load is dispatched while
      // today's route is still on the street.
      if (isVehicleOutOfOperation(findVehicle.status)) {
        throw new DeliveryVehicleUnavailableError();
      }

      vehicleLabel = findVehicle.license_plate;
    }

    // Duplicated ids in the selection are harmless — collapse them so the
    // count checks below stay honest.
    const uniqueIds = [...new Set(deliveryIds)];

    const deliveries = await this.delivery.findDeliveriesByIds(uniqueIds);

    if (deliveries.length !== uniqueIds.length) {
      throw new DeliveryNotFoundError();
    }

    if (deliveries.some((entry) => entry.businessId !== businessId)) {
      throw new DeliveryNotBelongBusinessError();
    }

    // All-or-nothing with the offenders named: the dispatcher fixes the
    // selection instead of hunting for what half-succeeded.
    const blocked = deliveries.filter((entry) => entry.status !== "PENDING");

    if (blocked.length > 0) {
      throw new DeliveryNotAssignableError(
        blocked.map((entry) => entry.code ?? entry.recipient_name),
      );
    }

    try {
      // The assignment and every event it announces in ONE transaction. The
      // write is already all-or-nothing; a loop of events after the commit is
      // not, and a crash halfway leaves a dispatcher's ERP holding twenty of
      // the forty documents that moved.
      await database.$transaction(async (tx) => {
        await this.delivery.assignDeliveries(
          uniqueIds,
          { driverId, vehicleId: vehicleId ?? null },
          tx,
        );

        // One event per document and not one for the batch: an integration
        // matches on a delivery, and an event carrying forty ids is an event
        // every subscriber has to unpack before it can do anything with it.
        for (const delivery of deliveries) {
          await this.webhooks.announce(
            "delivery.assigned",
            businessId,
            {
              ...deliveryEventPayload({ ...delivery, id: delivery.id! }),
              driver_id: driverId ?? null,
              vehicle_id: vehicleId ?? null,
            },
            tx,
          );
        }
      });

      const count = uniqueIds.length;
      const plural = count > 1 ? "s" : "";

      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "update",
        entityId: driverId,
        description:
          `${count} entrega${plural} atribuída${plural} ao motorista ` +
          `${findDriver.name}` +
          (vehicleLabel ? ` (veículo ${vehicleLabel})` : ""),
        status: "Designada",
        performedBy: userId,
        businessId,
      });

      return { assigned: count };
    } catch (error) {
      if (error instanceof DeliveryAssignmentConflictError) {
        throw new AppError(error.message, 409, "DELIVERY_ASSIGNMENT_CONFLICT");
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar atribuir as entregas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { AssignDeliveriesUseCase };

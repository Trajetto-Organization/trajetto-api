import { inject, injectable } from "tsyringe";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { KanbanService } from "@/shared/services/kanban-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";

import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";

import { ServiceOrderNewMileageRequireOrderFinalizedError } from "../errors/service-order-new-mileage-require-order-finalized-error";
import { ServiceOrderCompletionDateCannotBeEarlierOrderError } from "../errors/service-order-completion-date-cannot-be-earlier-order-date-error";

import { ServiceOrderLocationNotProvidedAdjustmentValidationError } from "../errors/service-order-location-not-provided-adjustment-validation-error";
import { ServiceOrderRegistrationsMobileLocationRequiredError } from "../errors/service-order-registrations-mobile-location-required-error";

import { UserResponsibleNotFoundError } from "@/modules/user/usecases/errors/user-responsible-not-found-error";

import {
  ServiceOrder,
  CreateServiceOrderProps,
} from "../../dtos/service-order-dto";

import { AppError } from "@/shared/errors/AppError";

import { calculateDistance } from "@/shared/utils/geolocation";
import {
  assertMileageNotBehind,
  recordMaintenanceMileage,
} from "../service-order-mileage";
import { logger } from "@/shared/logging/logger";
import { isUniqueViolation } from "@/shared/http/idempotency-key";
import { timeZoneOfBusiness } from "@/shared/time/business-time-zone";
import { pickedDateFromInput } from "@/shared/vehicle/record-dates";
import database from "@/../infra/database";

@injectable()
class CreateServiceOrderUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("SupplierRepository")
    private supplier: ISupplierRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("KanbanService")
    private kanbanService: KanbanService,
  ) {}

  async execute(
    serviceOrderData: CreateServiceOrderProps,
    userId: string,
  ): Promise<ServiceOrder> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      serviceOrderData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // The same form sent twice — a lost answer, a second click — is the order
    // it already created: no second card, no second notification, and the
    // odometer is not asked to move twice (IDEMP-14).
    const replay = await this.replayOf(serviceOrderData);

    if (replay) return replay;

    // Check if the vehicle exists and belongs to the company
    const findVehicle = await this.vehicle.findVehicleById(
      serviceOrderData.vehicleId,
    );

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== serviceOrderData.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    // Check if the branch exists and belongs to the company
    const findBranch = await this.branch.findBranchById(
      serviceOrderData.branchId,
    );

    if (!findBranch) {
      throw new BranchNotFoundError();
    }

    if (findBranch.businessId !== serviceOrderData.businessId) {
      throw new BranchNotBelongBusinessError();
    }

    // Check supplier if provided
    if (serviceOrderData.supplierId) {
      const findSupplier = await this.supplier.findSupplierById(
        serviceOrderData.supplierId,
      );

      if (!findSupplier) {
        throw new SupplierNotFoundError();
      }

      if (findSupplier.businessId !== serviceOrderData.businessId) {
        throw new SupplierNotBelongBusinessError();
      }
    }

    // Set the responsible user as the authenticated user if not provided
    if (!serviceOrderData.responsibleUserId) {
      serviceOrderData.responsibleUserId = userId;
    } else {
      // Check if the responsible user exists
      const findResponsibleUser = await this.user.findUserById(
        serviceOrderData.responsibleUserId,
      );

      if (!findResponsibleUser) {
        throw new UserResponsibleNotFoundError();
      }

      // Check if the responsible user belongs to the same company
      if (findResponsibleUser.businessId !== serviceOrderData.businessId) {
        throw new UserNotBelongBusinessError();
      }
    }

    // A bare day starts in the company's zone: as a string it reached
    // Prisma (500), and as 00:00 UTC it was the evening before in Brazil.
    const zone = timeZoneOfBusiness(findBusiness);

    serviceOrderData.date = pickedDateFromInput(serviceOrderData.date, zone);
    serviceOrderData.completion_date = pickedDateFromInput(
      serviceOrderData.completion_date,
      zone,
    );

    if (serviceOrderData.completion_date && serviceOrderData.date) {
      const orderDate = new Date(serviceOrderData.date);
      const completionDate = new Date(serviceOrderData.completion_date);

      if (completionDate < orderDate) {
        throw new ServiceOrderCompletionDateCannotBeEarlierOrderError();
      }
    }

    // 🔧 VALIDATION: If finalizing, new mileage is mandatory
    if (
      serviceOrderData.completion_date &&
      !serviceOrderData.new_mileage_after_service
    ) {
      throw new ServiceOrderNewMileageRequireOrderFinalizedError();
    }

    // The new mileage may equal the current one: a vehicle that stood in the
    // workshop did not move, and closing its order used to need a made-up
    // +0.1 km (FLEET-SO-4). Only a reading behind the odometer is refused.
    if (serviceOrderData.new_mileage_after_service) {
      assertMileageNotBehind(
        serviceOrderData.new_mileage_after_service,
        findVehicle.current_mileage,
      );
    }

    // 🔒 PERMISSION CHECK: Only MASTER can modify snapshot values
    let vehicleSnapshot;

    // A MASTER's edit of the vehicle, written in the order's transaction
    // below: it used to land before the order, and stay when the order failed.
    const vehicleUpdateData: any = {};

    if (findUser.role === "MASTER") {
      // MASTER can provide custom snapshot values
      vehicleSnapshot = {
        current_mileage_at_service: serviceOrderData.current_mileage_at_service,
        maintenance_interval_km_at_service:
          serviceOrderData.maintenance_interval_km_at_service,
        last_maintenance_mileage_at_service:
          serviceOrderData.last_maintenance_mileage_at_service,
      };

      // If MASTER is creating OS without completion date but with modified values, update vehicle
      if (!serviceOrderData.completion_date) {
        if (
          serviceOrderData.current_mileage_at_service !==
          findVehicle.current_mileage
        ) {
          vehicleUpdateData.current_mileage =
            serviceOrderData.current_mileage_at_service;
        }

        if (
          serviceOrderData.maintenance_interval_km_at_service !==
          findVehicle.maintenance_interval_km
        ) {
          vehicleUpdateData.maintenance_interval_km =
            serviceOrderData.maintenance_interval_km_at_service;
        }

        if (
          serviceOrderData.last_maintenance_mileage_at_service !==
          findVehicle.last_maintenance_mileage
        ) {
          vehicleUpdateData.last_maintenance_mileage =
            serviceOrderData.last_maintenance_mileage_at_service;
        }
      }
    } else {
      // Non-MASTER users get automatic snapshot from vehicle
      vehicleSnapshot = {
        current_mileage_at_service: findVehicle.current_mileage,
        maintenance_interval_km_at_service: findVehicle.maintenance_interval_km,
        last_maintenance_mileage_at_service:
          findVehicle.last_maintenance_mileage,
      };
    }

    // 🆕 GEOLOCATION LOGIC: Validate and process location data
    if (serviceOrderData.created_from === "MOBILE_APP") {
      // Mobile: Location is REQUIRED
      if (!serviceOrderData.latitude || !serviceOrderData.longitude) {
        throw new ServiceOrderRegistrationsMobileLocationRequiredError();
      }

      // 🆕 VALIDATE DISTANCE IF GPS_MANUAL (manual adjustment)
      if (serviceOrderData.location_source === "GPS_MANUAL") {
        // The GPS reading is needed to judge how far the pin was moved.
        if (
          !serviceOrderData.latitude_original ||
          !serviceOrderData.longitude_original
        ) {
          throw new ServiceOrderLocationNotProvidedAdjustmentValidationError();
        }

        // A pin moved too far from the GPS reading is refused as suspect.
        const distance = calculateDistance(
          serviceOrderData.latitude_original,
          serviceOrderData.longitude_original,
          serviceOrderData.latitude,
          serviceOrderData.longitude,
        );

        // A code of its own, so the app can tell it from a bad field.
        if (distance > 500) {
          throw new AppError(
            `A localização editada está ${Math.round(distance)}m distante da capturada pelo GPS. Máximo permitido: 500m. Possível inconsistência detectada.`,
            400,
            "LOCATION_ADJUSTMENT_TOO_FAR",
          );
        }

        // A structured line, so it can be filtered by event and user (OBS-14).
        // Persisting it in the activity trail is a separate decision.
        logger.info(
          {
            event: "audit.gps_adjusted",
            entity: "service_order",
            userId,
            distanceMeters: Math.round(distance),
          },
          "GPS location adjusted by the user",
        );
      } else if (!serviceOrderData.location_source) {
        // No source means the GPS reading was kept as captured.
        serviceOrderData.location_source = "GPS_AUTO";

        // Unedited: the original is the final location.
        serviceOrderData.latitude_original = serviceOrderData.latitude;
        serviceOrderData.longitude_original = serviceOrderData.longitude;
      }
    } else if (serviceOrderData.created_from === "WEB_DASHBOARD") {
      // Web: Location is OPTIONAL
      if (serviceOrderData.latitude && serviceOrderData.longitude) {
        serviceOrderData.location_source = "USER_MANUAL";
      } else {
        serviceOrderData.location_source = "NONE";
      }
    }

    // Add audit fields for web dashboard manual location
    if (
      serviceOrderData.created_from === "WEB_DASHBOARD" &&
      serviceOrderData.latitude &&
      serviceOrderData.longitude
    ) {
      (serviceOrderData as any).location_edited_by = userId;
      (serviceOrderData as any).location_edited_at = new Date();
    }

    try {
      // Order and outbox event commit together; the pipeline notifies the
      // responsible user and records the activity after the commit.
      const serviceOrderCreated = await database.$transaction(async (tx) => {
        // A MASTER's deliberate override of the vehicle: unconditional, but
        // now atomic with the order it came with.
        if (Object.keys(vehicleUpdateData).length > 0) {
          await this.vehicle.updateVehicle(
            {
              vehicleData: vehicleUpdateData,
              vehicleId: serviceOrderData.vehicleId,
            },
            tx,
          );
        }

        // Created already finished: the odometer moves with the order, in
        // the same commit, and only forward (IDEMP-15). It used to be a plain
        // update after the commit, judged against the read at the top — a
        // refuelling with a higher reading committed in between was written
        // over, and the counter ran backwards.
        if (
          serviceOrderData.completion_date &&
          serviceOrderData.new_mileage_after_service
        ) {
          await recordMaintenanceMileage(
            this.vehicle,
            {
              vehicleId: serviceOrderData.vehicleId,
              businessId: serviceOrderData.businessId,
              mileage: serviceOrderData.new_mileage_after_service,
              currentMileage: findVehicle.current_mileage,
              maintenanceDate: serviceOrderData.completion_date,
            },
            tx,
          );
        }

        const created = await this.serviceOrder.createServiceOrder(
          {
            ...serviceOrderData,
            // Uses snapshot values (from vehicle or custom from MASTER)
            ...vehicleSnapshot,
          },
          tx,
        );

        await this.outbox.publish(tx, {
          topic: "service-order.created",
          aggregateType: "service-order",
          aggregateId: created.id,
          businessId: serviceOrderData.businessId,
          actorId: userId,
          payload: {
            serviceOrderId: created.id,
            businessId: serviceOrderData.businessId,
            vehicleId: serviceOrderData.vehicleId,
            vehiclePlate: findVehicle.license_plate || null,
            totalAmount: Number(created.total_amount),
            currentMileage:
              (vehicleSnapshot.current_mileage_at_service as number) ?? null,
            newMileage:
              (serviceOrderData.new_mileage_after_service as number) ?? null,
            isCompleted: Boolean(created.completion_date),
            responsibleUserId: serviceOrderData.responsibleUserId,
          },
        });

        return created;
      });

      // Create kanban card asynchronously without blocking the main flow
      logger.debug(
        { component: "service-order", serviceOrderId: serviceOrderCreated.id },
        "creating the kanban card for a service order",
      );
      this.kanbanService.createCardFromServiceOrder({
        serviceOrderId: serviceOrderCreated.id,
        vehicleLicensePlate: findVehicle.license_plate || "",
        totalAmount: Number(serviceOrderCreated.total_amount) || 0,
        maintenanceType: serviceOrderData.maintenance_type,
        orderDate: serviceOrderData.date,
        completionDate: serviceOrderData.completion_date,
        responsibleUserId: serviceOrderData.responsibleUserId,
        businessId: serviceOrderData.businessId,
        createdByUserId: userId,
        timeZone: timeZoneOfBusiness(findBusiness),
      });

      return serviceOrderCreated;
    } catch (error) {
      // The twin of this submission committed after the replay check: the
      // insert met the unique key — or, for an order created finished, the
      // odometer guard met the mileage the twin had just written — and the
      // twin's order is the answer, not a refusal of an order that exists.
      if (isUniqueViolation(error) || error instanceof AppError) {
        const replay = await this.replayOf(serviceOrderData);

        if (replay) return replay;
      }

      // The refusal of a mileage that fell behind the odometer is the
      // user's to read, not a server fault.
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar criar a ordem de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }

  private async replayOf(
    serviceOrderData: CreateServiceOrderProps,
  ): Promise<ServiceOrder | null> {
    if (!serviceOrderData.client_submission_id) return null;

    return this.serviceOrder.findServiceOrderBySubmissionId(
      serviceOrderData.businessId,
      serviceOrderData.client_submission_id,
    );
  }
}

export { CreateServiceOrderUseCase };

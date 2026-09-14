import { inject, injectable } from "tsyringe";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";

import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { ServiceOrderNotBelongBusinessError } from "../errors/service-order-not-belong-business-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { ServiceOrderCompletionDateCannotBeEarlierOrderError } from "../errors/service-order-completion-date-cannot-be-earlier-order-date-error";
import { UserResponsibleNotFoundError } from "@/modules/user/usecases/errors/user-responsible-not-found-error";

import { ServiceOrderNewMileageRequireOrderFinalizedError } from "../errors/service-order-new-mileage-require-order-finalized-error";
import { ServiceOrderNotFoundError } from "../errors/service-order-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import {
  ServiceOrder,
  UpdateServiceOrderProps,
} from "../../dtos/service-order-dto";

import database from "@/../infra/database";

@injectable()
class UpdateServiceOrderUseCase {
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
  ) {}

  async execute(
    serviceOrderData: UpdateServiceOrderProps,
    serviceOrderId: string,
    businessId: string,
    userId: string,
  ): Promise<ServiceOrder> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findServiceOrder =
      await this.serviceOrder.findServiceOrderById(serviceOrderId);

    if (!findServiceOrder) {
      throw new ServiceOrderNotFoundError();
    }

    if (findServiceOrder.businessId !== businessId) {
      throw new ServiceOrderNotBelongBusinessError();
    }

    // Get current vehicle data for validation
    const currentVehicle = await this.vehicle.findVehicleById(
      serviceOrderData.vehicleId || findServiceOrder.vehicleId,
    );

    if (!currentVehicle) {
      throw new VehicleNotFoundError();
    }

    // Additional checks for relationships
    if (serviceOrderData.vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(
        serviceOrderData.vehicleId,
      );

      if (!findVehicle) {
        throw new VehicleNotFoundError();
      }

      if (findVehicle.businessId !== businessId) {
        throw new VehicleNotBelongBusinessError();
      }
    }

    if (serviceOrderData.branchId) {
      const findBranch = await this.branch.findBranchById(
        serviceOrderData.branchId,
      );

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    if (serviceOrderData.supplierId) {
      const findSupplier = await this.supplier.findSupplierById(
        serviceOrderData.supplierId,
      );

      if (!findSupplier) {
        throw new SupplierNotFoundError();
      }

      if (findSupplier.businessId !== businessId) {
        throw new SupplierNotBelongBusinessError();
      }
    }

    if (serviceOrderData.responsibleUserId) {
      const findResponsibleUser = await this.user.findUserById(
        serviceOrderData.responsibleUserId,
      );

      if (!findResponsibleUser) {
        throw new UserResponsibleNotFoundError();
      }

      if (findResponsibleUser.businessId !== businessId) {
        throw new UserNotBelongBusinessError();
      }
    }

    // Validate dates
    const orderDate = serviceOrderData.date
      ? new Date(serviceOrderData.date)
      : new Date(findServiceOrder.date);

    if (serviceOrderData.completion_date) {
      const completionDate = new Date(serviceOrderData.completion_date);

      if (completionDate < orderDate) {
        throw new ServiceOrderCompletionDateCannotBeEarlierOrderError();
      }
    }

    // 🔧 VALIDATION: If you are finishing now, new mileage is mandatory
    const wasCompleted = !!findServiceOrder.completion_date;
    const isBeingCompleted =
      !!serviceOrderData.completion_date && !wasCompleted;

    if (isBeingCompleted && !serviceOrderData.new_mileage_after_service) {
      throw new ServiceOrderNewMileageRequireOrderFinalizedError();
    }

    // 🔧 VALIDATION: New mileage must be > current vehicle mileage (strictly greater)
    if (serviceOrderData.new_mileage_after_service) {
      if (
        serviceOrderData.new_mileage_after_service <=
        currentVehicle.current_mileage
      ) {
        throw new AppError(
          `A nova quilometragem (${serviceOrderData.new_mileage_after_service} km) deve ser maior que a quilometragem atual do veículo (${currentVehicle.current_mileage} km)`,
          400,
        );
      }
    }

    // 🔒 PERMISSION CHECK: Only MASTER can update snapshot values
    let updateData: any = { ...serviceOrderData };

    // If user is not MASTER, remove snapshot fields from update
    if (findUser.role !== "MASTER") {
      delete updateData.current_mileage_at_service;
      delete updateData.maintenance_interval_km_at_service;

      delete updateData.last_maintenance_mileage_at_service;
    } else {
      // MASTER is updating snapshot values - update vehicle accordingly
      if (
        !findServiceOrder.completion_date &&
        !serviceOrderData.completion_date
      ) {
        const vehicleUpdateData: any = {};

        if (
          updateData.current_mileage_at_service !== undefined &&
          updateData.current_mileage_at_service !==
            findServiceOrder.current_mileage_at_service
        ) {
          vehicleUpdateData.current_mileage =
            updateData.current_mileage_at_service;
        }

        if (
          updateData.maintenance_interval_km_at_service !== undefined &&
          updateData.maintenance_interval_km_at_service !==
            findServiceOrder.maintenance_interval_km_at_service
        ) {
          vehicleUpdateData.maintenance_interval_km =
            updateData.maintenance_interval_km_at_service;
        }

        if (
          updateData.last_maintenance_mileage_at_service !== undefined &&
          updateData.last_maintenance_mileage_at_service !==
            findServiceOrder.last_maintenance_mileage_at_service
        ) {
          vehicleUpdateData.last_maintenance_mileage =
            updateData.last_maintenance_mileage_at_service;
        }

        if (Object.keys(vehicleUpdateData).length > 0) {
          await this.vehicle.updateVehicle({
            vehicleData: vehicleUpdateData,
            vehicleId: serviceOrderData.vehicleId || findServiceOrder.vehicleId,
          });
        }
      }
    }

    // 📍 GEOLOCATION LOGIC FOR UPDATE: Process location changes
    // Check if latitude or longitude were explicitly provided (not undefined)
    const hasLatitude = "latitude" in updateData;
    const hasLongitude = "longitude" in updateData;

    if (hasLatitude || hasLongitude) {
      // If both latitude and longitude are provided and not null
      if (
        updateData.latitude !== null &&
        updateData.longitude !== null &&
        updateData.latitude &&
        updateData.longitude
      ) {
        updateData.location_source = "USER_MANUAL";
        (updateData as any).location_edited_by = userId;
        (updateData as any).location_edited_at = new Date();
      }
      // If either is null, user is removing the location
      else if (updateData.latitude === null || updateData.longitude === null) {
        updateData.latitude = null;
        updateData.longitude = null;
        updateData.location_source = "NONE";
        updateData.latitude_original = null;
        updateData.longitude_original = null;
      }
    }

    try {
      // The plate feeds the notification texts; fetched before the update so
      // the transaction stays write-only.
      const vehicleForNotification = await this.vehicle.findVehicleById(
        serviceOrderData.vehicleId || findServiceOrder.vehicleId,
      );

      // Only a hand-over pages someone: an update that keeps the responsible
      // publishes with no recipient and feeds the activity trail alone.
      const responsibleUserChanged =
        serviceOrderData.responsibleUserId !== undefined &&
        findServiceOrder.responsibleUserId !==
          serviceOrderData.responsibleUserId;

      const updatedServiceOrder = await database.$transaction(async (tx) => {
        const updated = await this.serviceOrder.updateServiceOrder(
          { serviceOrderData: updateData, serviceOrderId },
          tx,
        );

        await this.outbox.publish(tx, {
          topic: "service-order.updated",
          aggregateType: "service-order",
          aggregateId: updated.id,
          businessId,
          actorId: userId,
          payload: {
            serviceOrderId: updated.id,
            businessId,
            vehicleId: updated.vehicleId,
            vehiclePlate: vehicleForNotification?.license_plate || null,
            totalAmount: Number(updated.total_amount),
            responsibleUserId:
              responsibleUserChanged && serviceOrderData.responsibleUserId
                ? serviceOrderData.responsibleUserId
                : null,
          },
        });

        return updated;
      });

      // 🔄 CONDITIONAL UPDATE: If you are finalizing the OS now
      if (isBeingCompleted && serviceOrderData.new_mileage_after_service) {
        // Get vehicleId from existing work order or update data
        const vehicleId =
          serviceOrderData.vehicleId || findServiceOrder.vehicleId;

        await this.vehicle.updateVehicle({
          vehicleData: {
            current_mileage: serviceOrderData.new_mileage_after_service,
            last_maintenance_date: serviceOrderData.completion_date,
            last_maintenance_mileage:
              serviceOrderData.new_mileage_after_service,
          },
          vehicleId: vehicleId,
        });
      }

      // If already was completed and updating new mileage
      if (
        wasCompleted &&
        serviceOrderData.new_mileage_after_service !== undefined
      ) {
        const vehicleId =
          serviceOrderData.vehicleId || findServiceOrder.vehicleId;

        await this.vehicle.updateVehicle({
          vehicleData: {
            current_mileage:
              serviceOrderData.new_mileage_after_service as number,
            last_maintenance_mileage:
              serviceOrderData.new_mileage_after_service,
          },
          vehicleId: vehicleId,
        });
      }

      return updatedServiceOrder;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a ordem de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateServiceOrderUseCase };

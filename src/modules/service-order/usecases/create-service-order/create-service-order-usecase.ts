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

    // 🔧 VALIDATION: New mileage must be > current vehicle mileage (strictly greater)
    if (serviceOrderData.new_mileage_after_service) {
      if (
        serviceOrderData.new_mileage_after_service <=
        findVehicle.current_mileage
      ) {
        throw new AppError(
          `A nova quilometragem (${serviceOrderData.new_mileage_after_service} km) deve ser maior que a quilometragem atual do veículo (${findVehicle.current_mileage} km)`,
          400,
        );
      }
    }

    // 🔒 PERMISSION CHECK: Only MASTER can modify snapshot values
    let vehicleSnapshot;

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
        const vehicleUpdateData: any = {};

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

        if (Object.keys(vehicleUpdateData).length > 0) {
          await this.vehicle.updateVehicle({
            vehicleData: vehicleUpdateData,
            vehicleId: serviceOrderData.vehicleId,
          });
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
        // Verifica se temos a localização original
        if (
          !serviceOrderData.latitude_original ||
          !serviceOrderData.longitude_original
        ) {
          throw new ServiceOrderLocationNotProvidedAdjustmentValidationError();
        }

        // Calcula e valida a distância
        const distance = calculateDistance(
          serviceOrderData.latitude_original,
          serviceOrderData.longitude_original,
          serviceOrderData.latitude,
          serviceOrderData.longitude,
        );

        if (distance > 500) {
          throw new AppError(
            `A localização editada está ${Math.round(distance)}m distante da capturada pelo GPS. Máximo permitido: 500m. Possível inconsistência detectada.`,
            400,
          );
        }

        // Log de auditoria (opcional)
        console.log(`[AUDIT] GPS ajustado por ${userId} na ordem de serviço`);
      } else if (!serviceOrderData.location_source) {
        // Se não tem source, é GPS automático
        serviceOrderData.location_source = "GPS_AUTO";

        // Copia localização final para original (não foi editada)
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

      // 🔄 UPDATE: If the OS was created and already completed, update the vehicle
      if (
        serviceOrderData.completion_date &&
        serviceOrderData.new_mileage_after_service
      ) {
        await this.vehicle.updateVehicle({
          vehicleData: {
            current_mileage: serviceOrderData.new_mileage_after_service,
            last_maintenance_date: serviceOrderData.completion_date,
            last_maintenance_mileage:
              serviceOrderData.new_mileage_after_service,
          },
          vehicleId: serviceOrderData.vehicleId,
        });
      }

      // Create kanban card asynchronously without blocking the main flow
      console.log(
        `[ServiceOrder] Criando card no kanban para ordem ${serviceOrderCreated.id}`,
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
      });

      return serviceOrderCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar a ordem de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateServiceOrderUseCase };

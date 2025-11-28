import { inject, injectable } from "tsyringe";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { KanbanService } from "@/shared/services/kanban-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";

import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";

import {
  ServiceOrder,
  CreateServiceOrderProps,
} from "../../dtos/service-order-dto";

import { AppError } from "@/shared/errors/AppError";
import { env } from "@/env";

import { formatCurrency } from "@/config/format-values";
import { redirectPage } from "@/shared/utils/link-redirect-page";

import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";
import { calculateDistance } from "@/shared/utils/geolocation";

interface ServiceOrderNotificationTextProps {
  serviceOrderId: string;
  vehicleLicensePlate: string;
  totalAmount: string;
  currentMileage?: number;
  newMileage?: number;
}

@injectable()
class CreateServiceOrderUseCase {
  private http_request = env.HTTP_REQUEST;

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
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("KanbanService")
    private kanbanService: KanbanService,
  ) {}

  private buildServiceOrderNotificationText({
    serviceOrderId,
    vehicleLicensePlate,
    totalAmount,
    currentMileage,
    newMileage,
  }: ServiceOrderNotificationTextProps): string {
    return [
      `🔧 *Nova Ordem de Serviço! Você foi designado como responsável por uma nova ordem de serviço*`,
      `Veículo: *${vehicleLicensePlate || "N/A"}*`,
      `Valor: *${formatCurrency(Number(totalAmount))}*`,
      currentMileage &&
        `Quilometragem: *${currentMileage}km${newMileage ? ` → ${newMileage}km` : ""}*`,
      `Identificador da ordem de serviço: *${serviceOrderId}*`,
      `Para mais detalhes, acesse o sistema.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async processNotifications(
    serviceOrderCreated: ServiceOrder,
    serviceOrderData: CreateServiceOrderProps,
    findVehicle: any,
    vehicleSnapshot: any,
    userId: string,
  ): Promise<void> {
    try {
      // Create activity for the user who created the service order
      const activityData = {
        type: "Ordem de serviço",
        action: "create",
        entityId: serviceOrderCreated.id,
        description: `Ordem de serviço criada para o veículo ${findVehicle.license_plate || "N/A"} no valor de ${formatCurrency(Number(serviceOrderCreated.total_amount))} | Quilometragem: ${vehicleSnapshot.current_mileage_at_service}km${serviceOrderData.new_mileage_after_service ? ` → ${serviceOrderData.new_mileage_after_service}km` : ""} | ID: ${serviceOrderCreated.id}`,
        status: serviceOrderCreated.completion_date ? "Completo" : "Pendente",
        performedBy: userId,
        businessId: serviceOrderData.businessId,
      };

      const findResponsibleUser = await this.user.findUserById(
        serviceOrderData.responsibleUserId,
      );

      if (findResponsibleUser) {
        const linkRedirectPage = redirectPage(findResponsibleUser?.role);

        const notificationData = {
          userId: serviceOrderData.responsibleUserId,
          type: "service-order",
          title: "Nova Ordem de Serviço",
          message: `Você foi designado como responsável pela ordem de serviço para o veículo ${findVehicle.license_plate || "N/A"}.`,
          entityId: serviceOrderCreated.id,
          link: `${this.http_request}/${linkRedirectPage}/service-order?search=${serviceOrderCreated.id}&page=1`,
          businessId: serviceOrderData.businessId,
          shouldSendEmail: true,
          shouldSendWhatsApp: true,
          whatsAppMessage: this.buildServiceOrderNotificationText({
            serviceOrderId: serviceOrderCreated.id,
            vehicleLicensePlate: findVehicle.license_plate || "N/A",
            totalAmount: serviceOrderCreated.total_amount as string,
            currentMileage: vehicleSnapshot.current_mileage_at_service,
            newMileage: serviceOrderData.new_mileage_after_service as number,
          }),
          instanceName: generateWhatsAppInstanceName(
            findResponsibleUser.email,
            serviceOrderData.businessId,
          ),
        };

        // Process notification to responsible user (if different from creator)
        await this.notificationService.processUserNotifications({
          notification: notificationData,
          activity: activityData,
        });
      } else {
        // Fallback: Create activity even if responsible user not found
        await this.notificationService.createActivityIfEnabled(activityData);
      }
    } catch (error) {
      console.error(
        "[Ordens de serviço] Erro ao processar notificações:",
        error,
      );
      // Does not prevent the creation of the service order
    }
  }

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
        throw new AppError("Usuário responsável não encontrado!", 400);
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
        throw new AppError(
          "A data de conclusão não pode ser anterior à data da ordem de serviço",
          400,
        );
      }
    }

    // 🔧 VALIDATION: If finalizing, new mileage is mandatory
    if (
      serviceOrderData.completion_date &&
      !serviceOrderData.new_mileage_after_service
    ) {
      throw new AppError(
        "A nova quilometragem é obrigatória quando a ordem de serviço é finalizada",
        400,
      );
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
        throw new AppError(
          "Para registros via aplicativo mobile, a localização é obrigatória.",
          400,
        );
      }

      // 🆕 VALIDATE DISTANCE IF GPS_MANUAL (manual adjustment)
      if (serviceOrderData.location_source === "GPS_MANUAL") {
        // Verifica se temos a localização original
        if (
          !serviceOrderData.latitude_original ||
          !serviceOrderData.longitude_original
        ) {
          throw new AppError(
            "Localização original não fornecida para validação de ajuste.",
            400,
          );
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
      const serviceOrderCreated = await this.serviceOrder.createServiceOrder({
        ...serviceOrderData,
        // Uses snapshot values (from vehicle or custom from MASTER)
        ...vehicleSnapshot,
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

      // Process notifications asynchronously without blocking the main flow
      this.processNotifications(
        serviceOrderCreated,
        serviceOrderData,
        findVehicle,
        vehicleSnapshot,
        userId,
      );

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

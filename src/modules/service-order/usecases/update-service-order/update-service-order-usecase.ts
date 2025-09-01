import { inject, injectable } from "tsyringe";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";

import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { ServiceOrderNotBelongBusinessError } from "../errors/service-order-not-belong-business-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";
import { NotificationService } from "@/shared/services/notification-service";

import { ServiceOrderNotFoundError } from "../errors/service-order-not-found-error";

import { AppError } from "@/shared/errors/AppError";

import {
  ServiceOrder,
  UpdateServiceOrderProps,
} from "../../dtos/service-order-dto";
import { formatCurrency } from "@/config/format-values";
import { redirectPage } from "@/shared/utils/link-redirect-page";
import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";
import { env } from "@/env";

interface ServiceOrderNotificationTextProps {
  totalAmount: string;
  licensePlate: string;
  serviceOrderId: string;
}

@injectable()
class UpdateServiceOrderUseCase {
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
  ) {}

  private buildServiceOrderNotificationText({
    totalAmount,
    licensePlate,
    serviceOrderId,
  }: ServiceOrderNotificationTextProps): string {
    return [
      `🔧 *Ordem de Serviço Atualizada! Você foi designado como responsável por uma ordem de serviço atualizada*`,
      `Veículo: *${licensePlate}*`,
      `Valor total: *${formatCurrency(Number(totalAmount))}*`,
      `Identificador da OS: *${serviceOrderId}*`,
      `Para mais detalhes, acesse o sistema.`,
    ].join("\n");
  }

  private async processNotifications(
    originalServiceOrder: ServiceOrder,
    updatedServiceOrder: ServiceOrder,
    serviceOrderData: UpdateServiceOrderProps,
    userId: string,
    businessId: string,
    vehicleLicensePlate: string,
  ): Promise<void> {
    try {
      // Always create activity for service order update
      const activityData = {
        type: "Ordem de serviço",
        action: "update",
        entityId: updatedServiceOrder.id,
        description: `Ordem de serviço atualizada para o veículo ${vehicleLicensePlate} no valor de ${formatCurrency(Number(updatedServiceOrder.total_amount))} | ID: ${updatedServiceOrder.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId,
      };

      // Check if responsibleUserId changed
      const responsibleUserChanged =
        serviceOrderData.responsibleUserId !== undefined &&
        originalServiceOrder.responsibleUserId !==
          serviceOrderData.responsibleUserId;

      if (responsibleUserChanged && serviceOrderData.responsibleUserId) {
        // ResponsibleUser changed, send notification
        const responsibleUser = await this.user.findUserById(
          serviceOrderData.responsibleUserId,
        );

        if (responsibleUser) {
          const linkRedirectPage = redirectPage(responsibleUser.role);

          const notificationData = {
            userId: serviceOrderData.responsibleUserId,
            type: "service-order",
            title: "Ordem de Serviço Atualizada e Atribuída",
            message: `Você foi designado como responsável por uma ordem de serviço atualizada para o veículo ${vehicleLicensePlate}`,
            entityId: updatedServiceOrder.id,
            link: `${this.http_request}/${linkRedirectPage}/service-order?search=${updatedServiceOrder.id}&page=1`,
            businessId,
            shouldSendEmail: true,
            shouldSendWhatsApp: true,
            whatsAppMessage: this.buildServiceOrderNotificationText({
              totalAmount: updatedServiceOrder.total_amount as string,
              licensePlate: vehicleLicensePlate,
              serviceOrderId: updatedServiceOrder.id,
            }),
            instanceName: generateWhatsAppInstanceName(
              responsibleUser.email,
              businessId,
            ),
          };

          // Process notification to newly assigned user
          await this.notificationService.processUserNotifications({
            notification: notificationData,
            activity: activityData,
          });
        }
      } else {
        // No responsibleUser change, just create activity
        await this.notificationService.createActivityIfEnabled(activityData);
      }
    } catch (error) {
      console.error(
        "[Service Order Update] Erro ao processar notificações:",
        error,
      );
      // Does not prevent the service order update
    }
  }

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
        throw new AppError("Usuário responsável não encontrado!", 400);
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
        throw new AppError(
          "A data de conclusão não pode ser anterior à data da ordem de serviço",
          400,
        );
      }
    }

    // 🔧 VALIDATION: If you are finishing now, new mileage is mandatory
    const wasCompleted = !!findServiceOrder.completion_date;
    const isBeingCompleted =
      !!serviceOrderData.completion_date && !wasCompleted;

    if (isBeingCompleted && !serviceOrderData.new_mileage_after_service) {
      throw new AppError(
        "A nova quilometragem é obrigatória quando a ordem de serviço é finalizada",
        400,
      );
    }

    // 🔧 VALIDATION: New mileage must be >= current vehicle mileage (not snapshot)
    if (serviceOrderData.new_mileage_after_service) {
      if (
        serviceOrderData.new_mileage_after_service <
        currentVehicle.current_mileage
      ) {
        throw new AppError(
          `A nova quilometragem (${serviceOrderData.new_mileage_after_service}) não pode ser menor que a quilometragem atual do veículo (${currentVehicle.current_mileage})`,
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

    try {
      const updatedServiceOrder = await this.serviceOrder.updateServiceOrder({
        serviceOrderData: updateData,
        serviceOrderId,
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

      const vehicle = await this.vehicle.findVehicleById(
        serviceOrderData.vehicleId || findServiceOrder.vehicleId,
      );

      // Process notifications (activity + conditionally WhatsApp/Email)
      this.processNotifications(
        findServiceOrder,
        updatedServiceOrder,
        serviceOrderData,
        userId,
        businessId,
        vehicle?.license_plate || "N/A",
      );

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

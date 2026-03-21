import { inject, injectable } from "tsyringe";

import { IServiceOrderPartRepository } from "@/modules/service-order-part/repositories/IService-order-part-repository";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { IPartRepository } from "@/modules/part/repositories/IPart-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";
import { PartNotFoundError } from "@/modules/part/usecases/errors/part-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { formatCurrency } from "@/shared/utils/format-values";

import { ServiceOrderPartNotFoundError } from "../errors/service-order-part-not-found-error";
import { ServiceOrderNotBelongBusinessError } from "@/modules/service-order/usecases/errors/service-order-not-belong-business-error";

import { ServiceOrderPartAlreadyExistsError } from "../errors/service-order-part-already-exists-error";
import { PartNotBelongError } from "@/modules/part/usecases/errors/part-not-belong-error";

import {
  ServiceOrderPart,
  UpdateServiceOrderPartProps,
} from "../../dtos/service-order-part-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class UpdateServiceOrderPartUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("PartRepository")
    private part: IPartRepository,
    @inject("ServiceOrderPartRepository")
    private serviceOrderPart: IServiceOrderPartRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    serviceOrderPartData: UpdateServiceOrderPartProps,
    serviceOrderPartId: string,
    serviceOrderId: string,
    businessId: string,
    userId: string,
  ): Promise<ServiceOrderPart> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Check if the service order exists and belongs to the company
    const findServiceOrder =
      await this.serviceOrder.findServiceOrderById(serviceOrderId);

    if (!findServiceOrder) {
      throw new ServiceOrderNotFoundError();
    }

    if (findServiceOrder.businessId !== businessId) {
      throw new ServiceOrderNotBelongBusinessError();
    }

    // Check if the work order part exists
    const findServiceOrderPart =
      await this.serviceOrderPart.findServiceOrderPartById(serviceOrderPartId);

    if (!findServiceOrderPart) {
      throw new ServiceOrderPartNotFoundError();
    }

    // If a new part is selected, check if it exists and belongs to the company
    if (serviceOrderPartData.partId) {
      const findPart = await this.part.findPartById(
        serviceOrderPartData.partId,
      );

      if (!findPart) {
        throw new PartNotFoundError();
      }

      if (findPart.businessId !== businessId) {
        throw new PartNotBelongError();
      }

      // Check if the new part has already been added to the work order (except the current one)
      const partAlreadyAdded =
        await this.serviceOrderPart.findServiceOrderPartByPartId(
          serviceOrderPartData.partId,
          serviceOrderId,
        );

      if (partAlreadyAdded && partAlreadyAdded.id !== serviceOrderPartId) {
        throw new ServiceOrderPartAlreadyExistsError();
      }
    }

    try {
      const updatedServiceOrderPart =
        await this.serviceOrderPart.updateServiceOrderPart({
          serviceOrderPartData: {
            ...serviceOrderPartData,
            serviceOrderId,
            businessId,
          },
          serviceOrderPartId,
        });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Peça da ordem de serviço",
        action: "update",
        entityId: updatedServiceOrderPart.id,
        description: `Peça da ordem de serviço atualizada: Preço: ${formatCurrency(Number(updatedServiceOrderPart.unit_price))} | Qtd: ${updatedServiceOrderPart.quantity} | OS: ${serviceOrderId} | ID: ${updatedServiceOrderPart.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId: businessId,
      });

      return updatedServiceOrderPart;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a peça da ordem de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateServiceOrderPartUseCase };

import { inject, injectable } from "tsyringe";

import { IServiceOrderPartRepository } from "@/modules/service-order-part/repositories/IService-order-part-repository";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { IPartRepository } from "@/modules/part/repositories/IPart-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";
import { PartNotFoundError } from "@/modules/part/usecases/errors/part-not-found-error";

import { ServiceOrderPartAlreadyExistsError } from "../errors/service-order-part-already-exists-error";

import { ServiceOrderNotBelongBusinessError } from "@/modules/service-order/usecases/errors/service-order-not-belong-business-error";
import { PartNotBelongServiceOrderError } from "@/modules/part/usecases/errors/part-not-belong-service-order-error";

import { NotificationService } from "@/shared/services/notification-service";

import { formatCurrency } from "@/config/format-values";
import { AppError } from "@/shared/errors/AppError";

import {
  ServiceOrderPart,
  CreateServiceOrderPartProps,
} from "../../dtos/service-order-part-dto";

@injectable()
class CreateServiceOrderPartUseCase {
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
    serviceOrderPartData: CreateServiceOrderPartProps,
    userId: string,
  ): Promise<ServiceOrderPart> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      serviceOrderPartData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Check if the service order exists and belongs to the company
    const findServiceOrder = await this.serviceOrder.findServiceOrderById(
      serviceOrderPartData.serviceOrderId,
    );

    if (!findServiceOrder) {
      throw new ServiceOrderNotFoundError();
    }

    if (findServiceOrder.businessId !== serviceOrderPartData.businessId) {
      throw new ServiceOrderNotBelongBusinessError();
    }

    // Check if the part exists and belongs to the company
    const findPart = await this.part.findPartById(serviceOrderPartData.partId);

    if (!findPart) {
      throw new PartNotFoundError();
    }

    if (findPart.businessId !== serviceOrderPartData.businessId) {
      throw new PartNotBelongServiceOrderError();
    }

    // Check if the part has already been added to the work order
    const partAlreadyAdded =
      await this.serviceOrderPart.findServiceOrderPartByPartId(
        serviceOrderPartData.partId,
        serviceOrderPartData.serviceOrderId,
      );

    if (partAlreadyAdded) {
      throw new ServiceOrderPartAlreadyExistsError();
    }

    // If no unit price is given, use the part price
    if (!serviceOrderPartData.unit_price) {
      serviceOrderPartData.unit_price = Number(findPart.unit_price);
    }

    try {
      const serviceOrderPartCreated =
        await this.serviceOrderPart.createServiceOrderPart(
          serviceOrderPartData,
        );

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Peça da ordem de serviço",
        action: "create",
        entityId: serviceOrderPartCreated.id,
        description: `Peça adicionada à ordem de serviço: ${findPart.description} | Preço: ${formatCurrency(Number(serviceOrderPartCreated.unit_price))} | Qtd: ${serviceOrderPartCreated.quantity} | OS: ${serviceOrderPartData.serviceOrderId} | ID: ${serviceOrderPartCreated.id}`,
        status: "Completo",
        performedBy: userId,
        businessId: serviceOrderPartData.businessId,
      });

      return serviceOrderPartCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar adicionar a peça à ordem de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateServiceOrderPartUseCase };

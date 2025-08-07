import { inject, injectable } from "tsyringe";

import { IServiceOrderPartRepository } from "@/modules/service-order-part/repositories/IService-order-part-repository";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";
import { NotificationService } from "@/shared/services/notification-service";

import { formatCurrency } from "@/config/format-values";
import { ServiceOrderPartNotFoundError } from "../errors/service-order-part-not-found-error";

import { ServiceOrderPart } from "../../dtos/service-order-part-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class DeleteServiceOrderPartUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("ServiceOrderPartRepository")
    private serviceOrderPart: IServiceOrderPartRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
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
      throw new AppError(
        "Esta ordem de serviço não pertence a esta empresa!",
        403,
      );
    }

    // Check if the work order part exists
    const findServiceOrderPart =
      await this.serviceOrderPart.findServiceOrderPartById(serviceOrderPartId);

    if (!findServiceOrderPart) {
      throw new ServiceOrderPartNotFoundError();
    }

    // Check if the work order part belongs to the work order
    if (findServiceOrderPart.serviceOrderId !== serviceOrderId) {
      throw new AppError(
        "Esta peça não pertence a esta ordem de serviço!",
        403,
      );
    }

    try {
      const deletedServiceOrderPart =
        await this.serviceOrderPart.deleteServiceOrderPart(serviceOrderPartId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Peça da ordem de serviço",
        action: "delete",
        entityId: deletedServiceOrderPart.id,
        description: `Peça removida da ordem de serviço: Preço: ${formatCurrency(Number(deletedServiceOrderPart.unit_price))} | Qtd: ${deletedServiceOrderPart.quantity} | OS: ${serviceOrderId} | ID: ${deletedServiceOrderPart.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId: businessId,
      });

      return deletedServiceOrderPart;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir a peça da ordem de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteServiceOrderPartUseCase };

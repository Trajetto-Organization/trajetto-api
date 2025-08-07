import { inject, injectable } from "tsyringe";

import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { ServiceOrderNotFoundError } from "../errors/service-order-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { ServiceOrder } from "../../dtos/service-order-dto";

import { ServiceOrderNotBelongBusinessError } from "../errors/service-order-not-belong-business-error";
import { formatCurrency } from "@/config/format-values";

@injectable()
class DeleteServiceOrderUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
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

    try {
      const deletedServiceOrder =
        await this.serviceOrder.deleteServiceOrder(serviceOrderId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Ordem de serviço",
        action: "delete",
        entityId: deletedServiceOrder.id,
        description: `Ordem de serviço deletada no valor de ${formatCurrency(Number(deletedServiceOrder.total_amount))} | ID: ${deletedServiceOrder.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId,
      });

      return deletedServiceOrder;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir a ordem de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteServiceOrderUseCase };

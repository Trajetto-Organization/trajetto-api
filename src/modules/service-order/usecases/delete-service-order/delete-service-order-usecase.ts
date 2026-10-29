import { inject, injectable } from "tsyringe";

import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { ServiceOrderNotFoundError } from "../errors/service-order-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { ServiceOrder } from "../../dtos/service-order-dto";

import { ServiceOrderDeleteBlockedError } from "../errors/service-order-delete-blocked-error";

import { formatCurrency } from "@/shared/utils/format-values";

interface DeleteServiceOrderResponse {
  deleted: ServiceOrder;
  /** Part lines removed with it (ON DELETE CASCADE). */
  partsRemoved: number;
}

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
  ): Promise<DeleteServiceOrderResponse> {
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

    // Another company's order is not found from here either: a distinct
    // answer confirmed the id exists elsewhere (decision 11.3).
    if (!findServiceOrder || findServiceOrder.businessId !== businessId) {
      throw new ServiceOrderNotFoundError();
    }

    let result: Awaited<
      ReturnType<IServiceOrderRepository["deleteServiceOrderGuarded"]>
    >;

    try {
      // The finished check and the bill count are decided again under the
      // order's lock: the read above can be stale by now.
      result = await this.serviceOrder.deleteServiceOrderGuarded(
        serviceOrderId,
        businessId,
      );
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir a ordem de serviço! Por favor, tente novamente.",
        500,
      );
    }

    if ("missing" in result) {
      throw new ServiceOrderNotFoundError();
    }

    if ("blocked" in result) {
      throw new ServiceOrderDeleteBlockedError(result.blocked);
    }

    const { deleted, partsRemoved } = result;

    // Process activity asynchronously without blocking the main flow
    this.notificationService.createActivityIfEnabled({
      type: "Ordem de serviço",
      action: "delete",
      entityId: deleted.id,
      description: `Ordem de serviço deletada no valor de ${formatCurrency(Number(deleted.total_amount))}${partsRemoved > 0 ? ` com ${partsRemoved} peça(s)` : ""} | ID: ${deleted.id}`,
      status: "Deletado",
      performedBy: userId,
      businessId,
    });

    return { deleted, partsRemoved };
  }
}

export { DeleteServiceOrderUseCase };

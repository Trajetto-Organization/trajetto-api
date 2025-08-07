import { inject, injectable } from "tsyringe";

import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { ListServiceOrderProps } from "../../dtos/service-order-dto";

@injectable()
class ListServiceOrderUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListServiceOrderProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const serviceOrders = await this.serviceOrder.listServiceOrders({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

      return serviceOrders;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as ordens de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListServiceOrderUseCase };

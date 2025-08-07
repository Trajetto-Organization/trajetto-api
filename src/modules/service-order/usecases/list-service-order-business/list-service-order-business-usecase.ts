import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IServiceOrderRepository } from "../../repositories/IService-order-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ListServiceOrderProps } from "../../dtos/service-order-dto";

@injectable()
class ListServiceOrderBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    businessId: string,
  ): Promise<ListServiceOrderProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    try {
      const serviceOrderList = await this.serviceOrder.listServiceOrderBusiness(
        {
          page,
          pageSize,
          businessId,
        },
      );

      return serviceOrderList;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista das ordens de serviço por empresa!",
        500,
      );
    }
  }
}

export { ListServiceOrderBusinessUseCase };

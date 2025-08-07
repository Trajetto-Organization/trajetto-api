import { inject, injectable } from "tsyringe";

import { IServiceOrderPartRepository } from "@/modules/service-order-part/repositories/IService-order-part-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ListServiceOrderPartProps } from "../../dtos/service-order-part-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListServiceOrderPartUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ServiceOrderPartRepository")
    private serviceOrderPart: IServiceOrderPartRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListServiceOrderPartProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const serviceOrderParts =
        await this.serviceOrderPart.listServiceOrderParts({
          page,
          pageSize,
          businessId: findUser.businessId as string,
          currentUserRole: findUser.role,
          search,
        });

      return serviceOrderParts;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as peças das ordens de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListServiceOrderPartUseCase };

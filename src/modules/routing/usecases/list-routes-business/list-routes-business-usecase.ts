import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IRouteRepository } from "../../repositories/IRoute-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ListRoutesProps, ListRoutesResult } from "../../dtos/route-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListRoutesBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
  ) {}

  async execute(
    props: ListRoutesProps,
    userId: string,
  ): Promise<ListRoutesResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(props.businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== props.businessId) {
        throw new AppError("Sem permissão para acessar esta empresa!", 403);
      }
    }

    try {
      const routes = await this.route.listRoutes(props);
      return routes;
    } catch (error) {
      console.error("[ListRoutesBusinessUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar listar as rotas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListRoutesBusinessUseCase };

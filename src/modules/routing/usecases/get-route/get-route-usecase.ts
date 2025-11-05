import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IRouteRepository } from "../../repositories/IRoute-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { RouteNotFoundError } from "../errors/route-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { Route } from "../../dtos/route-dto";

@injectable()
class GetRouteUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
  ) {}

  async execute(
    routeId: string,
    businessId: string,
    userId: string,
  ): Promise<Route> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== businessId) {
        throw new AppError("Sem permissão para acessar esta empresa!", 403);
      }
    }

    try {
      const foundRoute = await this.route.findRouteByBusinessAndId(
        routeId,
        businessId,
      );

      if (!foundRoute) {
        throw new RouteNotFoundError();
      }

      return foundRoute;
    } catch (error) {
      // Re-throw known errors without wrapping them
      if (error instanceof RouteNotFoundError) {
        throw error;
      }

      console.error("[GetRouteUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar buscar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { GetRouteUseCase };

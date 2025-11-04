import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { RouteNotFoundError } from "../errors/route-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { Route } from "../../dtos/route-dto";

@injectable()
class DeleteRouteUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
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

    const foundRoute = await this.route.findRouteByBusinessAndId(
      routeId,
      businessId,
    );

    if (!foundRoute) {
      throw new RouteNotFoundError();
    }

    try {
      const deletedRoute = await this.route.deleteRoute(routeId);

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "delete",
        entityId: deletedRoute.id,
        description: `Rota deletada | ${deletedRoute.id}`,
        status: "deleted",
        performedBy: userId,
        businessId,
      });

      return deletedRoute;
    } catch (error) {
      console.error("[DeleteRouteUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar deletar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteRouteUseCase };

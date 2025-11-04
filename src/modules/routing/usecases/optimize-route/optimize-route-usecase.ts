import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IRoutingProvider } from "@/shared/providers/routing-provider/IRouting-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { RoutingCalculationError } from "../errors/routing-calculation-error";
import { AppError } from "@/shared/errors/AppError";

import { OptimizeRouteProps, OptimizedRouteResult } from "../../dtos/route-dto";

@injectable()
class OptimizeRouteUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("RoutingProvider")
    private routingProvider: IRoutingProvider,
  ) {}

  async execute(
    data: OptimizeRouteProps,
    userId: string,
  ): Promise<OptimizedRouteResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(data.businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== data.businessId) {
        throw new AppError("Sem permissão para acessar esta empresa!", 403);
      }
    }

    // Validate coordinates (minimum 2 points)
    if (data.coordinates.length < 2) {
      throw new AppError(
        "É necessário fornecer pelo menos 2 coordenadas para otimizar a rota!",
        400,
      );
    }

    try {
      // Optimize route via OSRM Provider
      const optimizedRoute = await this.routingProvider.optimizeRoute({
        coordinates: data.coordinates,
        roundtrip: data.roundtrip,
        source: data.source,
        destination: data.destination,
      });

      return optimizedRoute;
    } catch (error) {
      console.error("[OptimizeRouteUseCase] Error:", error);
      throw new RoutingCalculationError(
        error instanceof Error ? error.message : undefined,
      );
    }
  }
}

export { OptimizeRouteUseCase };

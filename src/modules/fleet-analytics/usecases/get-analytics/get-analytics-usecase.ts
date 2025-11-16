import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFleetAnalyticsRepository } from "../../repositories/IFleetAnalytics-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { FleetAnalyticsNotFoundError } from "../errors/fleet-analytics-not-found-error";

import { FleetAnalytics } from "../../dtos/fleet-analytics-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class GetAnalyticsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FleetAnalyticsRepository")
    private fleetAnalytics: IFleetAnalyticsRepository,
  ) {}

  async execute(analyticsId: string, userId: string): Promise<FleetAnalytics> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const findAnalytics = await this.fleetAnalytics.findById(analyticsId);

      if (!findAnalytics) {
        throw new FleetAnalyticsNotFoundError();
      }

      // Multi-tenancy validation
      if (findUser.role !== "MASTER") {
        if (findUser.businessId !== findAnalytics.businessId) {
          throw new AppError("Sem permissão para acessar esta análise!", 403);
        }
      }

      return findAnalytics;
    } catch (error) {
      // Re-throw known errors
      if (error instanceof FleetAnalyticsNotFoundError) {
        throw error;
      }

      if (error instanceof AppError) {
        throw error;
      }

      console.error("[GetAnalyticsUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar buscar a análise! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { GetAnalyticsUseCase };

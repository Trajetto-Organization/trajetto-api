import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IFleetAnalyticsRepository } from "../../repositories/IFleetAnalytics-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import {
  ListFleetAnalyticsProps,
  ListFleetAnalyticsResult,
} from "../../dtos/fleet-analytics-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListAnalyticsBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("FleetAnalyticsRepository")
    private fleetAnalytics: IFleetAnalyticsRepository,
  ) {}

  async execute(
    props: ListFleetAnalyticsProps,
    userId: string,
  ): Promise<ListFleetAnalyticsResult> {
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
      const analytics = await this.fleetAnalytics.listByBusiness(props);
      return analytics;
    } catch (error) {
      console.error("[ListAnalyticsBusinessUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar listar as análises! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListAnalyticsBusinessUseCase };

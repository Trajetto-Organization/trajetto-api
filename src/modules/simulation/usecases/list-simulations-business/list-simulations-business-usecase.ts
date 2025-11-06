import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ISimulationRepository } from "../../repositories/ISimulation-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import {
  ListSimulationsProps,
  ListSimulationsResult,
} from "../../dtos/simulation-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListSimulationsBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("SimulationRepository")
    private simulation: ISimulationRepository,
  ) {}

  async execute(
    props: ListSimulationsProps,
    userId: string,
  ): Promise<ListSimulationsResult> {
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
      const simulations = await this.simulation.listByBusiness(props);
      return simulations;
    } catch (error) {
      console.error("[ListSimulationsBusinessUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar listar as simulações! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListSimulationsBusinessUseCase };

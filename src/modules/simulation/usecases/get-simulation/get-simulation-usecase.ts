import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ISimulationRepository } from "../../repositories/ISimulation-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { SimulationNotFoundError } from "../errors/simulation-not-found-error";

import { Simulation } from "../../dtos/simulation-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class GetSimulationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SimulationRepository")
    private simulation: ISimulationRepository,
  ) {}

  async execute(simulationId: string, userId: string): Promise<Simulation> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const findSimulation = await this.simulation.findById(simulationId);

      if (!findSimulation) {
        throw new SimulationNotFoundError();
      }

      // Multi-tenancy validation
      if (findUser.role !== "MASTER") {
        if (findUser.businessId !== findSimulation.businessId) {
          throw new AppError("Sem permissão para acessar esta simulação!", 403);
        }
      }

      return findSimulation;
    } catch (error) {
      // Re-throw known errors
      if (error instanceof SimulationNotFoundError) {
        throw error;
      }

      console.error("[GetSimulationUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar buscar a simulação! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { GetSimulationUseCase };

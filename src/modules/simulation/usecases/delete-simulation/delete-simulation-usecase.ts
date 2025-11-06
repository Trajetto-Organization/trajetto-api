import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ISimulationRepository } from "../../repositories/ISimulation-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { SimulationNotFoundError } from "../errors/simulation-not-found-error";

import { Simulation } from "../../dtos/simulation-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class DeleteSimulationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SimulationRepository")
    private simulation: ISimulationRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(simulationId: string, userId: string): Promise<Simulation> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findSimulation = await this.simulation.findById(simulationId);

    if (!findSimulation) {
      throw new SimulationNotFoundError();
    }

    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== findSimulation.businessId) {
        throw new AppError("Sem permissão para deletar esta simulação!", 403);
      }
    }

    try {
      const deletedSimulation = await this.simulation.delete(simulationId);

      this.notificationService.createActivityIfEnabled({
        type: "Simulação",
        action: "delete",
        entityId: deletedSimulation.id,
        description: `Simulação deletada | ${deletedSimulation.name}`,
        status: "deleted",
        performedBy: userId,
        businessId: findSimulation.businessId,
      });

      return deletedSimulation;
    } catch (error) {
      console.error("[DeleteSimulationUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar deletar a simulação! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteSimulationUseCase };

import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ISimulationRepository } from "../../repositories/ISimulation-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { SimulationNotFoundError } from "../errors/simulation-not-found-error";

import { UpdateSimulationProps, Simulation } from "../../dtos/simulation-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class UpdateSimulationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SimulationRepository")
    private simulation: ISimulationRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    data: UpdateSimulationProps,
    userId: string,
  ): Promise<Simulation> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findSimulation = await this.simulation.findById(data.id);

    if (!findSimulation) {
      throw new SimulationNotFoundError();
    }

    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== findSimulation.businessId) {
        throw new AppError("Sem permissão para atualizar esta simulação!", 403);
      }
    }

    try {
      const updatedSimulation = await this.simulation.update(data);

      this.notificationService.createActivityIfEnabled({
        type: "Simulação",
        action: "update",
        entityId: updatedSimulation.id,
        description: `Simulação atualizada | ${updatedSimulation.name}`,
        status: updatedSimulation.status,
        performedBy: userId,
        businessId: findSimulation.businessId,
      });

      return updatedSimulation;
    } catch (error) {
      console.error("[UpdateSimulationUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar atualizar a simulação! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateSimulationUseCase };

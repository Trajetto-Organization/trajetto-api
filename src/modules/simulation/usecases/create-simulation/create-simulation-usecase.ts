import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ISimulationRepository } from "../../repositories/ISimulation-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { CreateSimulationProps, Simulation } from "../../dtos/simulation-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class CreateSimulationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("SimulationRepository")
    private simulation: ISimulationRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    data: CreateSimulationProps,
    userId: string,
  ): Promise<Simulation> {
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

    try {
      const createdSimulation = await this.simulation.create(data);

      this.notificationService.createActivityIfEnabled({
        type: "Simulação",
        action: "create",
        entityId: createdSimulation.id,
        description: `Simulação criada | ${createdSimulation.name}`,
        status: createdSimulation.status,
        performedBy: userId,
        businessId: data.businessId,
      });

      return createdSimulation;
    } catch (error) {
      console.error("[CreateSimulationUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar criar a simulação! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateSimulationUseCase };

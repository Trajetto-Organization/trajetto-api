import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFleetAnalyticsRepository } from "../../repositories/IFleetAnalytics-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { FleetAnalyticsNotFoundError } from "../errors/fleet-analytics-not-found-error";

import { FleetAnalytics } from "../../dtos/fleet-analytics-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class DeleteAnalyticsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FleetAnalyticsRepository")
    private fleetAnalytics: IFleetAnalyticsRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(analyticsId: string, userId: string): Promise<FleetAnalytics> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findAnalytics = await this.fleetAnalytics.findById(analyticsId);

    if (!findAnalytics) {
      throw new FleetAnalyticsNotFoundError();
    }

    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== findAnalytics.businessId) {
        throw new AppError("Sem permissão para deletar esta análise!", 403);
      }
    }

    try {
      const deletedAnalytics = await this.fleetAnalytics.delete(analyticsId);

      this.notificationService.createActivityIfEnabled({
        type: "Análise de Frota",
        action: "delete",
        entityId: deletedAnalytics.id,
        description: `Análise deletada | ${deletedAnalytics.analyticsType} | ${deletedAnalytics.period}`,
        status: "deleted",
        performedBy: userId,
        businessId: findAnalytics.businessId,
      });

      return deletedAnalytics;
    } catch (error) {
      console.error("[DeleteAnalyticsUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar deletar a análise! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteAnalyticsUseCase };

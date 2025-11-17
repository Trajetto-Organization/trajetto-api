import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import FleetCommandWorkerService from "@/shared/services/fleet-command-worker-service";
import { GenerateHeatmapProps } from "../../dtos/heatmap-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { InvalidHeatmapTypeError } from "../errors/invalid-heatmap-type-error";
import { InvalidDateRangeError } from "../errors/invalid-date-range-error";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class GenerateHeatmapUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(data: GenerateHeatmapProps, userId: string) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(data.businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Validate permission (multi-tenancy)
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== data.businessId) {
        throw new AppError("Sem permissão para acessar esta empresa!", 403);
      }
    }

    // Validate heatmap type
    const validTypes = ["fines", "fuel", "maintenance"];

    if (!validTypes.includes(data.heatmapType)) {
      throw new InvalidHeatmapTypeError();
    }

    // Validate date range
    if (data.startDate >= data.endDate) {
      throw new InvalidDateRangeError();
    }

    try {
      // Enqueue job via Worker Thread
      const fleetCommandWorker = FleetCommandWorkerService.getInstance();

      await fleetCommandWorker.enqueueJob({
        jobType: "heatmap",
        businessId: data.businessId,
        userId,
        data: {
          heatmapType: data.heatmapType,
          startDate: data.startDate,
          endDate: data.endDate,
          vehicleId: data.vehicleId,
          filters: data.filters,
        },
      });

      console.log(
        `[GenerateHeatmapUseCase] Heatmap job enqueued via Worker Thread: ${data.heatmapType}`,
      );

      return {
        heatmap: {
          type: data.heatmapType,
          period: {
            startDate: data.startDate,
            endDate: data.endDate,
          },
          status: "processing",
        },
        status: "processing",
        message:
          "Heatmap enfileirado para processamento. Os dados serão gerados em breve.",
      };
    } catch (error) {
      console.error(
        "[GenerateHeatmapUseCase] Error enqueueing heatmap job:",
        error,
      );
      throw new AppError(
        "Erro ao enfileirar heatmap. Tente novamente mais tarde.",
        500,
      );
    }
  }
}

export { GenerateHeatmapUseCase };

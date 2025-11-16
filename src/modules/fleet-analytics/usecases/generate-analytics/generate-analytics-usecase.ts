import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import FleetCommandWorkerService from "@/shared/services/fleet-command-worker-service";

import {
  GenerateAnalyticsRequest,
  GenerateAnalyticsResponse,
} from "../../dtos/fleet-analytics-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { InvalidAnalyticsTypeError } from "../errors/invalid-analytics-type-error";
import { InvalidDateRangeError } from "../errors/invalid-date-range-error";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class GenerateAnalyticsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    data: GenerateAnalyticsRequest,
    userId: string,
  ): Promise<GenerateAnalyticsResponse> {
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

    // Validate analytics type
    const validTypes = [
      "route_efficiency",
      "cost_analysis",
      "vehicle_utilization",
      "fuel_consumption",
      "maintenance_cost",
    ];

    if (!validTypes.includes(data.analyticsType)) {
      throw new InvalidAnalyticsTypeError();
    }

    // Validate date range
    if (data.startDate >= data.endDate) {
      throw new InvalidDateRangeError();
    }

    try {
      // Enqueue job via Worker Thread
      const fleetCommandWorker = FleetCommandWorkerService.getInstance();

      await fleetCommandWorker.enqueueJob({
        jobType: "analytics",
        businessId: data.businessId,
        userId,
        data: {
          analyticsType: data.analyticsType,
          period: data.period,
          startDate: data.startDate,
          endDate: data.endDate,
          metadata: data.metadata,
        },
      });

      console.log(
        `[GenerateAnalyticsUseCase] Analytics job enqueued via Worker Thread: ${data.analyticsType}`,
      );

      return {
        analytics: {
          id: "processing",
          analyticsType: data.analyticsType,
          period: data.period,
          startDate: data.startDate,
          endDate: data.endDate,
          results: {} as any,
          businessId: data.businessId,
          created_at: new Date(),
          updated_at: new Date(),
        },
        status: "processing",
        message:
          "Análise enfileirada para processamento. Você receberá uma notificação quando estiver pronta.",
      };
    } catch (error) {
      console.error(
        "[GenerateAnalyticsUseCase] Error enqueueing analytics job:",
        error,
      );
      throw new AppError(
        "Erro ao enfileirar análise. Tente novamente mais tarde.",
        500,
      );
    }
  }
}

export { GenerateAnalyticsUseCase };

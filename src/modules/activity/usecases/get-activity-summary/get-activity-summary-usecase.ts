import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IActivityRepository } from "../../repositories/IActivity-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import { ActivitySummary } from "../../dtos/activity-dto";

interface GetActivitySummaryRequest {
  userId: string;
  /** Only the master sends it, to scope the panel to one company. */
  businessId?: string;
  periodDays: number;
}

@injectable()
class GetActivitySummaryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ActivityRepository")
    private activity: IActivityRepository,
  ) {}

  async execute({
    userId,
    businessId,
    periodDays,
  }: GetActivitySummaryRequest): Promise<ActivitySummary> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Non-master users are pinned to their own company, whatever they ask.
    const resolvedBusinessId =
      findUser.role === "MASTER"
        ? businessId
        : (findUser.businessId ?? undefined);

    if (resolvedBusinessId && findUser.role !== "MASTER") {
      assertTenantAccess(findUser, resolvedBusinessId);
    }

    try {
      return await this.activity.summarizeActivities({
        currentUserRole: findUser.role,
        businessId: resolvedBusinessId,
        userId: findUser.id as string,
        periodDays,
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Não foi possível recuperar o resumo de atividades!",
        500,
      );
    }
  }
}

export { GetActivitySummaryUseCase };

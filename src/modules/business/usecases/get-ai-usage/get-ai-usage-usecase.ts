import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { getQuotaUsage } from "@/shared/ai/ai-quota-service";

interface GetAIUsageRequest {
  userId: string;
  businessId: string;
}

@injectable()
class GetAIUsageUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({ userId, businessId }: GetAIUsageRequest) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // BUSINESS_ADMIN can only see their own business
    if (
      findUser.role === "BUSINESS_ADMIN" &&
      findUser.businessId !== businessId
    ) {
      throw new BusinessNotFoundError();
    }

    const business = await this.business.findAIUsage(businessId);

    if (!business) {
      throw new BusinessNotFoundError();
    }

    // Consumption comes from the AIUsagePeriod ledger. The response keeps the
    // legacy field names the frontends already render; "reset_at" maps to the
    // start of the current period (when this month's counting began).
    // "used" counts only finished provider calls — analyses still running
    // ride in "in_progress" (their reservation lowers "remaining" so nothing
    // over-grants, but a running analysis is not a completed verification).
    const usage = await getQuotaUsage(businessId);

    return {
      ...business,
      ai_analysis_used: usage?.consumed ?? 0,
      ai_analysis_in_progress: usage?.inProgress ?? 0,
      ai_analysis_reset_at: usage?.periodStart ?? null,
      ai_analysis_remaining: usage?.remaining ?? business.ai_analysis_limit,
      ai_analysis_enabled: business.ai_analysis_limit > 0,
    };
  }
}

export { GetAIUsageUseCase };

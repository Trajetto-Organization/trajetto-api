import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

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

    return {
      ...business,
      ai_analysis_remaining: Math.max(
        0,
        business.ai_analysis_limit - business.ai_analysis_used,
      ),
      ai_analysis_enabled: business.ai_analysis_limit > 0,
    };
  }
}

export { GetAIUsageUseCase };

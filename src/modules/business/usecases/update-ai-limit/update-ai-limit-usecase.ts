import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { OutboxService } from "@/shared/notifications/outbox-service";


interface UpdateAILimitRequest {
  userId: string;
  businessId: string;
  ai_analysis_limit: number;
}

@injectable()
class UpdateAILimitUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  async execute({
    userId,
    businessId,
    ai_analysis_limit,
  }: UpdateAILimitRequest) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Defense-in-depth: checks if the user belongs to the company (in case the middleware changes)
    if (findUser.role !== "MASTER" && findUser.businessId !== businessId) {
      throw new BusinessNotFoundError();
    }

    // Same reasoning as the fleet limit: the movement is the record.
    const previousValue = findBusiness.ai_analysis_limit ?? 0;

    const updatedBusiness = await this.business.updateAILimit(
      businessId,
      ai_analysis_limit,
    );

    if (previousValue !== ai_analysis_limit) {
      await this.outbox.publishAfterCommit({
        topic: "business-limit.changed",
        aggregateType: "business",
        aggregateId: businessId,
        businessId,
        actorId: userId,
        payload: {
          businessId,
          businessName: findBusiness.corporate_reason,
          limit: "ai",
          previousValue,
          newValue: ai_analysis_limit,
          actor: {
            id: findUser.id,
            name: findUser.name,
            email: findUser.email,
            role: findUser.role,
          },
        },
      });
    }

    return updatedBusiness;
  }
}

export { UpdateAILimitUseCase };

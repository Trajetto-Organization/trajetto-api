import { inject, injectable } from "tsyringe";
import { assertCallerRole } from "../errors/business-role-guard";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { OutboxService } from "@/shared/notifications/outbox-service";

import database from "@/../infra/database";


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

    // MASTER-only, like the route: see assertCallerRole.
    assertCallerRole(findUser, ["MASTER"]);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Same reasoning as the fleet limit: the movement is the record, and the
    // limit and its notice commit together (OUTBOX-10).
    return database.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ ai_analysis_limit: number | null }>>`
        SELECT "ai_analysis_limit" FROM "business" WHERE "id" = ${businessId} FOR NO KEY UPDATE
      `;

      const previousValue = locked?.ai_analysis_limit ?? 0;

      const updatedBusiness = await this.business.updateAILimit(
        businessId,
        ai_analysis_limit,
        tx,
      );

      if (previousValue !== ai_analysis_limit) {
        await this.outbox.publish(tx, {
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
    });
  }
}

export { UpdateAILimitUseCase };

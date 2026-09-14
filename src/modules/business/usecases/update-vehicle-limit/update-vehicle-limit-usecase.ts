import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { OutboxService } from "@/shared/notifications/outbox-service";


interface UpdateVehicleLimitRequest {
  userId: string;
  businessId: string;
  vehicle_limit: number;
}

@injectable()
class UpdateVehicleLimitUseCase {
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
    vehicle_limit,
  }: UpdateVehicleLimitRequest) {
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

    // Captured before the write: an audit entry that only says "20" cannot
    // tell a plan upgrade from a downgrade.
    const previousValue = findBusiness.vehicle_limit ?? 0;

    // Lowering below the current fleet is allowed: existing vehicles stay,
    // only new registrations get blocked by create-vehicle.
    const updatedBusiness = await this.business.updateVehicleLimit(
      businessId,
      vehicle_limit,
    );

    if (previousValue !== vehicle_limit) {
      await this.outbox.publishAfterCommit({
        topic: "business-limit.changed",
        aggregateType: "business",
        aggregateId: businessId,
        businessId,
        actorId: userId,
        payload: {
          businessId,
          businessName: findBusiness.corporate_reason,
          limit: "vehicle",
          previousValue,
          newValue: vehicle_limit,
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

export { UpdateVehicleLimitUseCase };

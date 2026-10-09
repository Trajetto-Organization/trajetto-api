import { inject, injectable } from "tsyringe";
import { assertCallerRole } from "../errors/business-role-guard";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { OutboxService } from "@/shared/notifications/outbox-service";

import database from "@/../infra/database";


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

    // MASTER-only, like the route: see assertCallerRole.
    assertCallerRole(findUser, ["MASTER"]);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // The limit and its notice commit together (OUTBOX-10). Published after
    // the update had committed, a failure in between lost the notice for
    // good: the retry read the new value as the previous one and saw no
    // change to announce.
    return database.$transaction(async (tx) => {
      // Captured before the write, under the row lock so a concurrent change
      // cannot slip between the read and the update: an audit entry that
      // only says "20" cannot tell a plan upgrade from a downgrade. NO KEY
      // UPDATE leaves the foreign-key checks of the company's own writes
      // alone (see manage-entitlements).
      const [locked] = await tx.$queryRaw<Array<{ vehicle_limit: number | null }>>`
        SELECT "vehicle_limit" FROM "business" WHERE "id" = ${businessId} FOR NO KEY UPDATE
      `;

      const previousValue = locked?.vehicle_limit ?? 0;

      // Lowering below the current fleet is allowed: existing vehicles stay,
      // only new registrations get blocked by create-vehicle.
      const updatedBusiness = await this.business.updateVehicleLimit(
        businessId,
        vehicle_limit,
        tx,
      );

      if (previousValue !== vehicle_limit) {
        await this.outbox.publish(tx, {
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
    });
  }
}

export { UpdateVehicleLimitUseCase };

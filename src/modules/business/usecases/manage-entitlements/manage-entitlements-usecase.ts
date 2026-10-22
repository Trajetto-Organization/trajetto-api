import { inject, injectable } from "tsyringe";
import { BusinessModule } from "@prisma/client";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { assertCallerRole } from "@/modules/business/usecases/errors/business-role-guard";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import {
  getBusinessEntitlements,
  getModuleImpact,
  setModuleEnabled,
  type ModuleImpact,
} from "@/shared/entitlements/entitlement-service";

import { sendEntitlementsChangedEvent } from "@/websocket";
import { OutboxService } from "@/shared/notifications/outbox-service";

import database from "@/../infra/database";

interface GetEntitlementsRequest {
  userId: string;
  businessId: string;
}

/**
 * The company's plan in one response: hired modules plus the contracted
 * fleet usage — what the master screen edits and what the limits card
 * shows the business admin.
 */
@injectable()
class GetBusinessEntitlementsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
  ) {}

  async execute({ userId, businessId }: GetEntitlementsRequest) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Same answers as the route's guards (role, then tenant), so the result
    // does not depend on which wall caught the request.
    assertCallerRole(findUser, ["MASTER", "BUSINESS_ADMIN"]);
    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // vehicle_count = active fleet (slots in use); INACTIVE vehicles keep
    // their history but free their contracted slot.
    const [modules, activeCount, inactiveCount] = await Promise.all([
      getBusinessEntitlements(businessId),
      this.vehicle.countActiveVehiclesByBusinessId(businessId),
      this.vehicle.countInactiveVehiclesByBusinessId(businessId),
    ]);

    return {
      modules,
      vehicle_limit: findBusiness.vehicle_limit ?? 0,
      vehicle_count: activeCount,
      vehicle_inactive_count: inactiveCount,
      vehicle_limit_enabled: (findBusiness.vehicle_limit ?? 0) > 0,
    };
  }
}

interface ModuleImpactRequest {
  userId: string;
  businessId: string;
  module: BusinessModule;
}

/**
 * What the master is about to take away, counted now.
 *
 * MASTER-only (route-guarded): it reads across a company's whole dataset, and
 * it exists to fill the confirmation dialog with numbers instead of adjectives.
 */
@injectable()
class GetModuleImpactUseCase {
  constructor(
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    businessId,
    module,
  }: ModuleImpactRequest): Promise<ModuleImpact> {
    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    return getModuleImpact(businessId, module);
  }
}

interface UpdateEntitlementRequest {
  userId: string;
  businessId: string;
  module: BusinessModule;
  enabled: boolean;
}

/** MASTER-only (route-guarded): flips a module on/off for a company. */
@injectable()
class UpdateBusinessEntitlementUseCase {
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
    module,
    enabled,
  }: UpdateEntitlementRequest): Promise<void> {
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

    /**
     * The switch and its notice commit together (OUTBOX-10).
     *
     * The event is the mandatory notice to masters and admins — the tripwire
     * of a stolen MASTER session — and the plan's audit line. Written after
     * the switch had committed, a failure in between left the module changed
     * with no event, and the admin's retry found the state already there and
     * returned early: the notice was lost for good.
     *
     * The company row is locked first, so two concurrent switches serialize
     * and the second reads the state the first left: one change, one notice.
     * NO KEY UPDATE and not UPDATE: the stronger lock also conflicts with the
     * key-share every foreign-key check takes on this row, so the switch
     * waited for any open write of the company, and the company's next
     * writes queued behind the switch.
     */
    const changed = await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "business" WHERE "id" = ${businessId} FOR NO KEY UPDATE`;

      // Read before writing: the notification and the audit entry both state
      // the movement, not just the destination.
      const currentRows = await getBusinessEntitlements(businessId, tx);

      const previousEnabled = currentRows.some(
        (row) => row.module === module && row.enabled,
      );

      // Re-affirming the current state is not a plan change; publishing it
      // would page every master over nothing.
      if (previousEnabled === enabled) return false;

      await setModuleEnabled(businessId, module, enabled, tx);

      await this.outbox.publish(tx, {
        topic: "business-module.changed",
        aggregateType: "business",
        aggregateId: businessId,
        businessId,
        actorId: userId,
        payload: {
          businessId,
          businessName: findBusiness.corporate_reason,
          module,
          enabled,
          previousEnabled,
          actor: {
            id: findUser.id,
            name: findUser.name,
            email: findUser.email,
            role: findUser.role,
          },
        },
      });

      return true;
    });

    if (!changed) return;

    // After the commit: connected clients redraw their navigation for a
    // change that happened; nobody is disconnected — the module gate on the
    // API is the enforcement point.
    sendEntitlementsChangedEvent(businessId, { module, enabled });
  }
}

export {
  GetBusinessEntitlementsUseCase,
  UpdateBusinessEntitlementUseCase,
  GetModuleImpactUseCase,
};

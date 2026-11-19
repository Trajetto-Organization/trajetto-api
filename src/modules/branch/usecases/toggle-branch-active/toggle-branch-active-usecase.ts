import { inject, injectable } from "tsyringe";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Branch } from "../../dtos/branch-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "../errors/branch-not-found-error";
import { ToggleConflictError } from "@/modules/business/usecases/errors/toggle-conflict-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { NotificationService } from "@/shared/services/notification-service";
import {
  announceSessionRevocation,
  sendCatalogChangedEvent,
} from "@/websocket";

import type { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { totalOpenRoutes } from "@/modules/driver/driver-rules";
import { DriverHasOpenRoutesError } from "@/modules/driver/usecases/errors/driver-has-open-routes-error";

@injectable()
class ToggleBranchActiveUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("DriverRepository")
    private driver: IDriverRepository,
  ) {}

  async execute(
    branchId: string,
    businessId: string,
    userId: string,
  ): Promise<Branch> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const findBranch = await this.branch.findBranchById(branchId);

    // Another company's branch answers like a missing one (decision 11.3).
    if (!findBranch || findBranch.businessId !== businessId) {
      throw new BranchNotFoundError();
    }

    // An inactive branch locks its drivers out of the app (session
    // eligibility), so a route one of them still has would never close — the
    // same reason a driver with open routes is not deactivated (K10, decision
    // D31). Only deactivating: reactivating is what lets such a route run.
    if (findBranch.is_active !== false) {
      const openRoutes = await this.driver.countOpenRoutesOfBranch(branchId);

      if (totalOpenRoutes(openRoutes) > 0) {
        throw new DriverHasOpenRoutesError(openRoutes, "DEACTIVATE_BRANCH");
      }
    }

    /**
     * The value that was read is the precondition for the write.
     *
     * Reading `is_active` and writing its opposite loses one of two
     * simultaneous flips: both read the same state, both write the same
     * opposite, and the activity feed records two entries for one change.
     */
    const updatedBranch = await this.branch.toggleBranchActive(
      branchId,
      // NOT NULL with `@default(true)` in the schema; the DTO widens it.
      findBranch.is_active ?? true,
    );

    if (!updatedBranch) {
      throw new ToggleConflictError("desta filial");
    }

    const newStatus = updatedBranch.is_active;

    // An inactive branch ends its drivers' sessions: they leave the session
    // cache of this replica now, and the others read the trigger's row at
    // once (plano-escala F5-23).
    if (!newStatus) announceSessionRevocation("branch", branchId);

    const statusLabel = newStatus ? "Ativo" : "Inativo";

    this.notificationService.createActivityIfEnabled({
      type: "Filial",
      action: "update",
      entityId: branchId,
      description: `Filial ${updatedBranch.corporate_reason} ${newStatus ? "ativada" : "desativada"}`,
      status: statusLabel,
      performedBy: userId,
      businessId: businessId,
    });

    // An inactive branch leaves the pickers of every open screen.
    sendCatalogChangedEvent(businessId, "branch");

    // Its drivers too: the chat pickers list a driver "com o app" only while
    // their branch is active, under the `driver` keys (decision 2.3).
    sendCatalogChangedEvent(businessId, "driver");

    return updatedBranch;
  }
}

export { ToggleBranchActiveUseCase };

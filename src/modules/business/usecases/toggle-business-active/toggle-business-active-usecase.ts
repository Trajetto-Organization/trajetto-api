import { inject, injectable } from "tsyringe";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "../errors/business-not-found-error";
import { ToggleConflictError } from "../errors/toggle-conflict-error";
import { assertCallerRole } from "../errors/business-role-guard";

import { NotificationService } from "@/shared/services/notification-service";
import { sendSecurityEventToBusiness } from "@/websocket";

import { Business } from "../../dtos/business-dto";

import database from "@/../infra/database";

@injectable()
class ToggleBusinessActiveUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(businessId: string, userId: string): Promise<Business> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // MASTER-only, like the route: see assertCallerRole.
    assertCallerRole(findUser, ["MASTER"]);

    const existingBusiness = await this.business.findBusinessById(businessId);

    if (!existingBusiness) {
      throw new BusinessNotFoundError();
    }

    /**
     * The value that was read is the precondition for the write.
     *
     * Reading `is_active` and writing its opposite is a lost update waiting
     * for two clicks: both read `true`, both write `false`, and the company
     * ends up deactivated once for two actions — while BOTH requests go on to
     * broadcast the disconnect below.
     */
    // The switch and its audit entry commit together (OUTBOX-10).
    const updatedBusiness = await database.$transaction(async (tx) => {
      const toggled = await this.business.toggleBusinessActive(
        businessId,
        // The column is NOT NULL with `@default(true)`; the DTO widens it to
        // optional, so the default is spelled out rather than assumed.
        existingBusiness.is_active ?? true,
        tx,
      );

      if (!toggled) return null;

      await this.notificationService.createActivityIfEnabled(
        {
          type: "Empresa",
          action: "update",
          entityId: businessId,
          description: `Empresa ${toggled.corporate_reason} ${toggled.is_active ? "ativada" : "desativada"}`,
          status: toggled.is_active ? "Ativo" : "Inativo",
          performedBy: userId,
          businessId: businessId,
        },
        tx,
      );

      return toggled;
    });

    if (!updatedBusiness) {
      throw new ToggleConflictError("desta empresa");
    }

    // When deactivating a business, end all its users' sessions via WS, with
    // the company's own reason (decision 4.1): the app words it ("empresa
    // desativada"), and the web logs out directly on `business_inactive`
    // through its socket reason map (as it does for `role_changed` and
    // `branch_inactive`); it re-reads /user/me only for reasons it does not
    // map.
    if (updatedBusiness.is_active === false) {
      sendSecurityEventToBusiness(businessId, { reason: "business_inactive" });
    }

    return updatedBusiness;
  }
}

export { ToggleBusinessActiveUseCase };

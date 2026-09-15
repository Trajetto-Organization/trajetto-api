import { inject, injectable } from "tsyringe";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "../errors/business-not-found-error";
import { ToggleConflictError } from "../errors/toggle-conflict-error";

import { NotificationService } from "@/shared/services/notification-service";
import { sendSecurityEventToBusiness } from "@/websocket";

import { Business } from "../../dtos/business-dto";

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
    const updatedBusiness = await this.business.toggleBusinessActive(
      businessId,
      // The column is NOT NULL with `@default(true)`; the DTO widens it to
      // optional, so the default is spelled out rather than assumed.
      existingBusiness.is_active ?? true,
    );

    if (!updatedBusiness) {
      throw new ToggleConflictError("desta empresa");
    }

    const newStatus = updatedBusiness.is_active;

    const statusLabel = newStatus ? "Ativo" : "Inativo";

    // When deactivating a business, force-disconnect all its users via WS
    // (reuses access_revoked reason → frontend already redirects to login)
    if (newStatus === false) {
      sendSecurityEventToBusiness(businessId, { reason: "access_revoked" });
    }

    this.notificationService.createActivityIfEnabled({
      type: "Empresa",
      action: "update",
      entityId: businessId,
      description: `Empresa ${updatedBusiness.corporate_reason} ${newStatus ? "ativada" : "desativada"}`,
      status: statusLabel,
      performedBy: userId,
      businessId: businessId,
    });

    return updatedBusiness;
  }
}

export { ToggleBusinessActiveUseCase };

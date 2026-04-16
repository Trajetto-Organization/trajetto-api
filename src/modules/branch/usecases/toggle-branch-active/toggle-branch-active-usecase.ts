import { inject, injectable } from "tsyringe";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Branch } from "../../dtos/branch-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "../errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "../errors/branch-not-belong-business-error";

import { NotificationService } from "@/shared/services/notification-service";

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

    const findBranch = await this.branch.findBranchById(branchId);

    if (!findBranch) {
      throw new BranchNotFoundError();
    }

    if (findBranch.businessId !== businessId) {
      throw new BranchNotBelongBusinessError();
    }

    const newStatus = !findBranch.is_active;

    const updatedBranch = await this.branch.updateBranch({
      branchData: { is_active: newStatus } as any,
      branchId,
    });

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

    return updatedBranch;
  }
}

export { ToggleBranchActiveUseCase };

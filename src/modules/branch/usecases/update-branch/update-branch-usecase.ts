import { inject, injectable } from "tsyringe";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Branch, UpdateBranchProps } from "../../dtos/branch-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "../errors/branch-not-found-error";

import { BranchCnpjAlreadyExistsError } from "../errors/branch-cnpj-already-exists-error";
import { BranchErpCodeAlreadyExistsError } from "../errors/branch-erp-code-already-exists-error";

import { BranchEmailAlreadyExistsError } from "../errors/branch-email-already-exists-error";
import { BranchNameAlreadyExistsError } from "../errors/branch-name-already-exists-error";

import { branchUniqueViolation } from "../errors/branch-unique-violation";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import { sendCatalogChangedEvent } from "@/websocket";

@injectable()
class UpdateBranchUseCase {
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
    branchData: UpdateBranchProps,
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

    // Another company's branch answers like a missing one, for everyone:
    // "not yours" confirmed the id existed elsewhere, and a branch never
    // moves between companies, not even by the MASTER.
    if (!findBranch || findBranch.businessId !== businessId) {
      throw new BranchNotFoundError();
    }

    // Uniqueness inside THIS company only (decision 8.1).
    if (
      branchData.corporate_reason &&
      branchData.corporate_reason !== findBranch.corporate_reason
    ) {
      const findBranchByCorporateReason =
        await this.branch.findBranchByCorporateReason(
          businessId,
          branchData.corporate_reason,
        );

      if (
        findBranchByCorporateReason &&
        findBranchByCorporateReason.id !== branchId
      ) {
        throw new BranchNameAlreadyExistsError();
      }
    }

    // The ERP code is the customer's own numbering, unique per company.
    if (branchData.erp_code && branchData.erp_code !== findBranch.erp_code) {
      const findBranchByErpCode = await this.branch.findBranchByErpCode(
        businessId,
        branchData.erp_code,
      );

      if (findBranchByErpCode && findBranchByErpCode.id !== branchId) {
        throw new BranchErpCodeAlreadyExistsError();
      }
    }

    if (branchData.email && branchData.email !== findBranch.email) {
      const findBranchByEmail = await this.branch.findBranchByEmail(
        businessId,
        branchData.email,
      );

      if (findBranchByEmail && findBranchByEmail.id !== branchId) {
        throw new BranchEmailAlreadyExistsError();
      }
    }

    // The CNPJ is national: taken by any other branch, or by a company other
    // than this one. The answer names nobody.
    if (branchData.cnpj && branchData.cnpj !== findBranch.cnpj) {
      const findBranchByCnpj = await this.branch.findBranchByCnpj(
        branchData.cnpj,
      );

      if (findBranchByCnpj && findBranchByCnpj.id !== branchId) {
        throw new BranchCnpjAlreadyExistsError();
      }

      const findBusinessByCnpj = await this.business.findBusinessByCnpj(
        branchData.cnpj,
      );

      if (findBusinessByCnpj && findBusinessByCnpj.id !== businessId) {
        throw new BranchCnpjAlreadyExistsError();
      }
    }

    let updatedBranch: Branch;

    try {
      updatedBranch = await this.branch.updateBranch({
        branchData,
        branchId,
      });
    } catch (error) {
      const duplicate = branchUniqueViolation(error);

      if (duplicate) throw duplicate;

      throw new AppError(
        "Houve um erro ao tentar atualizar a filial! Por favor, tente novamente.",
        500,
      );
    }

    // Process activity asynchronously without blocking the main flow
    this.notificationService.createActivityIfEnabled({
      type: "Filial",
      action: "update",
      entityId: updatedBranch.id,
      description: `Filial atualizada com sucesso: ${updatedBranch.corporate_reason} | CNPJ: ${updatedBranch.cnpj} | ID: ${updatedBranch.id}`,
      status: "Atualizado",
      performedBy: userId,
      businessId: businessId,
    });

    sendCatalogChangedEvent(businessId, "branch");

    return updatedBranch;
  }
}

export { UpdateBranchUseCase };

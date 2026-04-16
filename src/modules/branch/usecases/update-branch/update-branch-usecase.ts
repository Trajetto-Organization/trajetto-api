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

import { BusinessCorporateReasonAlreadyExistsError } from "@/modules/business/usecases/errors/business-corporate-reason-already-exists-error";
import { BusinessErpCodeAlreadyExistsError } from "@/modules/business/usecases/errors/business-erp-code-already-exists-error";

import { BusinessEmailAlreadyExistsError } from "@/modules/business/usecases/errors/business-email-already-exists-error";
import { BusinessCnpjAlreadyExistsError } from "@/modules/business/usecases/errors/business-cnpj-already-exists-error";

import { BranchNotBelongBusinessError } from "../errors/branch-not-belong-business-error";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

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

    const findBranch = await this.branch.findBranchById(branchId);

    if (!findBranch) {
      throw new BranchNotFoundError();
    }

    if (findBranch.businessId !== businessId) {
      throw new BranchNotBelongBusinessError();
    }

    if (
      branchData.corporate_reason &&
      branchData.corporate_reason !== findBranch.corporate_reason
    ) {
      const findBranchByCorporateReason =
        await this.branch.findBranchByCorporateReason(
          branchData.corporate_reason,
        );

      if (
        findBranchByCorporateReason &&
        findBranchByCorporateReason.id !== branchId
      ) {
        throw new BranchNameAlreadyExistsError();
      }
    }

    if (branchData.cnpj && branchData.cnpj !== findBranch.cnpj) {
      const findBranchByCnpj = await this.branch.findBranchByCnpj(
        branchData.cnpj,
      );

      if (findBranchByCnpj && findBranchByCnpj.id !== branchId) {
        throw new BranchCnpjAlreadyExistsError();
      }
    }

    if (branchData.erp_code && branchData.erp_code !== findBranch.erp_code) {
      const findBranchByErpCode = await this.branch.findBranchByErpCode(
        branchData.erp_code,
      );

      if (findBranchByErpCode && findBranchByErpCode.id !== branchId) {
        throw new BranchErpCodeAlreadyExistsError();
      }
    }

    if (branchData.email && branchData.email !== findBranch.email) {
      const findBranchByEmail = await this.branch.findBranchByEmail(
        branchData.email,
      );

      if (findBranchByEmail && findBranchByEmail.id !== branchId) {
        throw new BranchEmailAlreadyExistsError();
      }
    }

    if (branchData.cnpj && branchData.cnpj !== findBranch.cnpj) {
      const findBusinessByCnpj = await this.business.findBusinessByCnpj(
        branchData.cnpj,
      );

      if (findBusinessByCnpj && findBusinessByCnpj.id !== businessId) {
        throw new BusinessCnpjAlreadyExistsError();
      }
    }

    if (
      branchData.corporate_reason &&
      branchData.corporate_reason !== findBranch.corporate_reason
    ) {
      const findBusinessByCorporateReason =
        await this.business.findBusinessByCorporateReason(
          branchData.corporate_reason,
        );

      if (
        findBusinessByCorporateReason &&
        findBusinessByCorporateReason.id !== businessId
      ) {
        throw new BusinessCorporateReasonAlreadyExistsError();
      }
    }

    if (branchData.erp_code && branchData.erp_code !== findBranch.erp_code) {
      const findBusinessByErpcode = await this.business.findBusinessByErpcode(
        branchData.erp_code,
      );

      if (findBusinessByErpcode && findBusinessByErpcode.id !== businessId) {
        throw new BusinessErpCodeAlreadyExistsError();
      }
    }

    if (branchData.email && branchData.email !== findBranch.email) {
      const findBusinessByEmail = await this.business.findBusinessByEmail(
        branchData.email,
      );

      if (findBusinessByEmail && findBusinessByEmail.id !== businessId) {
        throw new BusinessEmailAlreadyExistsError();
      }
    }

    try {
      const updatedBranch = await this.branch.updateBranch({
        branchData,
        branchId,
      });

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

      return updatedBranch;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a filial! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateBranchUseCase };

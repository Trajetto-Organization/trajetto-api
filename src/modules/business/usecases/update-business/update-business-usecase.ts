import { inject, injectable } from "tsyringe";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { Business, UpdateBusinessProps } from "../../dtos/business-dto";

import { NotificationService } from "@/shared/services/notification-service";

import { BusinessCnpjAlreadyExistsError } from "../errors/business-cnpj-already-exists-error";
import { BusinessCorporateReasonAlreadyExistsError } from "../errors/business-corporate-reason-already-exists-error";

import { BusinessErpCodeAlreadyExistsError } from "../errors/business-erp-code-already-exists-error";
import { BusinessEmailAlreadyExistsError } from "../errors/business-email-already-exists-error";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNameAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-name-already-exists-error";
import { BranchCnpjAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-cnpj-already-exists-error";

import { BranchErpCodeAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-erp-code-already-exists-error";
import { BranchEmailAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-email-already-exists-error";

interface UpdateBusiness {
  businessData: UpdateBusinessProps;
  businessId: string;
  userId: string;
}

@injectable()
class UpdateBusinessUseCase {
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

  async execute({
    businessData,
    businessId,
    userId,
  }: UpdateBusiness): Promise<Business> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const existingBusiness = await this.business.findBusinessById(businessId);

    if (!existingBusiness) {
      throw new BusinessNotFoundError();
    }

    // First, we find the parent company associated with this company.
    const matrixBranch = await this.branch.findBranchByCnpj(
      existingBusiness.cnpj,
    );

    // Checks with other companies
    if (businessData.cnpj) {
      const findBusinessByCnpj = await this.business.findBusinessByCnpj(
        businessData.cnpj,
      );

      if (findBusinessByCnpj && findBusinessByCnpj.id !== businessId) {
        throw new BusinessCnpjAlreadyExistsError();
      }
    }

    if (businessData.corporate_reason) {
      const findBusinessByCorporateReason =
        await this.business.findBusinessByCorporateReason(
          businessData.corporate_reason,
        );

      if (
        findBusinessByCorporateReason &&
        findBusinessByCorporateReason.id !== businessId
      ) {
        throw new BusinessCorporateReasonAlreadyExistsError();
      }
    }

    if (businessData.erp_code) {
      const findBusinessByErpcode = await this.business.findBusinessByErpcode(
        businessData.erp_code,
      );

      if (findBusinessByErpcode && findBusinessByErpcode.id !== businessId) {
        throw new BusinessErpCodeAlreadyExistsError();
      }
    }

    if (businessData.email) {
      const findBusinessByEmail = await this.business.findBusinessByEmail(
        businessData.email,
      );

      if (findBusinessByEmail && findBusinessByEmail.id !== businessId) {
        throw new BusinessEmailAlreadyExistsError();
      }
    }

    // Checks with other branches (excluding the parent branch of the same company)
    if (businessData.cnpj) {
      const findBranchByCnpj = await this.branch.findBranchByCnpj(
        businessData.cnpj,
      );

      if (
        findBranchByCnpj &&
        (!matrixBranch || findBranchByCnpj.id !== matrixBranch.id)
      ) {
        throw new BranchCnpjAlreadyExistsError();
      }
    }

    if (businessData.corporate_reason) {
      const findBranchByCorporateReason =
        await this.branch.findBranchByCorporateReason(
          businessData.corporate_reason,
        );

      if (
        findBranchByCorporateReason &&
        (!matrixBranch || findBranchByCorporateReason.id !== matrixBranch.id)
      ) {
        throw new BranchNameAlreadyExistsError();
      }
    }

    if (businessData.erp_code) {
      const findBranchByErpCode = await this.branch.findBranchByErpCode(
        businessData.erp_code,
      );

      if (
        findBranchByErpCode &&
        (!matrixBranch || findBranchByErpCode.id !== matrixBranch.id)
      ) {
        throw new BranchErpCodeAlreadyExistsError();
      }
    }

    if (businessData.email) {
      const findBranchByEmail = await this.branch.findBranchByEmail(
        businessData.email,
      );

      if (
        findBranchByEmail &&
        (!matrixBranch || findBranchByEmail.id !== matrixBranch.id)
      ) {
        throw new BranchEmailAlreadyExistsError();
      }
    }

    try {
      const businessUpdated = await this.business.updateBusiness({
        businessData,
        businessId,
      });

      // Also update the branch matrix
      if (matrixBranch) {
        const branchUpdateData = Object.fromEntries(
          Object.entries(businessData).map(([key, value]) => [
            key,
            value === null ? undefined : value,
          ]),
        );

        await this.branch.updateBranch({
          branchData: branchUpdateData,
          branchId: matrixBranch.id,
        });
      }

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Empresa",
        action: "update",
        entityId: businessId,
        description: `Empresa ${businessUpdated.corporate_reason} atualizada`,
        status: "Atualizado",
        performedBy: userId,
        businessId,
      });

      return businessUpdated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a empresa! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateBusinessUseCase };

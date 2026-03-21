import { inject, injectable } from "tsyringe";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Branch, CreateBranchProps } from "../../dtos/branch-dto";

import { BranchNameAlreadyExistsError } from "../errors/branch-name-already-exists-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchCnpjAlreadyExistsError } from "../errors/branch-cnpj-already-exists-error";
import { BranchEmailAlreadyExistsError } from "../errors/branch-email-already-exists-error";

import { BranchErpCodeAlreadyExistsError } from "../errors/branch-erp-code-already-exists-error";

import { BusinessCnpjAlreadyExistsError } from "@/modules/business/usecases/errors/business-cnpj-already-exists-error";
import { BusinessCorporateReasonAlreadyExistsError } from "@/modules/business/usecases/errors/business-corporate-reason-already-exists-error";

import { BusinessErpCodeAlreadyExistsError } from "@/modules/business/usecases/errors/business-erp-code-already-exists-error";
import { BusinessEmailAlreadyExistsError } from "@/modules/business/usecases/errors/business-email-already-exists-error";

import { AppError } from "@/shared/errors/AppError";
import { NotificationService } from "@/shared/services/notification-service";

@injectable()
class CreateBranchUseCase {
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
    branchData: CreateBranchProps,
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

    // Checks with other branches
    const findBranchByCorporateReason =
      await this.branch.findBranchByCorporateReason(
        branchData.corporate_reason,
      );

    if (findBranchByCorporateReason) {
      throw new BranchNameAlreadyExistsError();
    }

    const findBranchByCnpj = await this.branch.findBranchByCnpj(
      branchData.cnpj,
    );

    if (findBranchByCnpj) {
      throw new BranchCnpjAlreadyExistsError();
    }

    if (branchData.erp_code) {
      const findBranchByErpCode = await this.branch.findBranchByErpCode(
        branchData.erp_code,
      );

      if (findBranchByErpCode) {
        throw new BranchErpCodeAlreadyExistsError();
      }
    }

    const findBranchByEmail = await this.branch.findBranchByEmail(
      branchData.email,
    );

    if (findBranchByEmail) {
      throw new BranchEmailAlreadyExistsError();
    }

    // New checks with companies (except the company to which this branch will belong)
    if (branchData.cnpj !== findBusiness.cnpj) {
      const findOtherBusinessByCnpj = await this.business.findBusinessByCnpj(
        branchData.cnpj,
      );

      if (
        findOtherBusinessByCnpj &&
        findOtherBusinessByCnpj.id !== businessId
      ) {
        throw new BusinessCnpjAlreadyExistsError();
      }
    }

    if (branchData.corporate_reason !== findBusiness.corporate_reason) {
      const findOtherBusinessByCorporateReason =
        await this.business.findBusinessByCorporateReason(
          branchData.corporate_reason,
        );

      if (
        findOtherBusinessByCorporateReason &&
        findOtherBusinessByCorporateReason.id !== businessId
      ) {
        throw new BusinessCorporateReasonAlreadyExistsError();
      }
    }

    if (branchData.erp_code && branchData.erp_code !== findBusiness.erp_code) {
      const findOtherBusinessByErpcode =
        await this.business.findBusinessByErpcode(branchData.erp_code);

      if (
        findOtherBusinessByErpcode &&
        findOtherBusinessByErpcode.id !== businessId
      ) {
        throw new BusinessErpCodeAlreadyExistsError();
      }
    }

    if (branchData.email !== findBusiness.email) {
      const findOtherBusinessByEmail = await this.business.findBusinessByEmail(
        branchData.email,
      );

      if (
        findOtherBusinessByEmail &&
        findOtherBusinessByEmail.id !== businessId
      ) {
        throw new BusinessEmailAlreadyExistsError();
      }
    }

    try {
      const branchCreated = await this.branch.createBranch({
        ...branchData,
        businessId,
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Filial",
        action: "create",
        entityId: branchCreated.id,
        description: `Filial criada com sucesso: ${branchCreated.corporate_reason} | CNPJ: ${branchCreated.cnpj} | ID: ${branchCreated.id}`,
        status: "Completo",
        performedBy: userId,
        businessId: businessId,
      });

      return branchCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar a filial! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateBranchUseCase };

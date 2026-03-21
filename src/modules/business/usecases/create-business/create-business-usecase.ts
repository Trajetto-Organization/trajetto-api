import { inject, injectable } from "tsyringe";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { Business, CreateBusinessProps } from "../../dtos/business-dto";
import { AppError } from "@/shared/errors/AppError";

import { BusinessEmailAlreadyExistsError } from "../errors/business-email-already-exists-error";
import { BusinessErpCodeAlreadyExistsError } from "../errors/business-erp-code-already-exists-error";

import { BusinessCorporateReasonAlreadyExistsError } from "../errors/business-corporate-reason-already-exists-error";
import { BusinessCnpjAlreadyExistsError } from "../errors/business-cnpj-already-exists-error";

import { BranchNameAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-name-already-exists-error";
import { BranchCnpjAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-cnpj-already-exists-error";

import { BranchErpCodeAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-erp-code-already-exists-error";
import { BranchEmailAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-email-already-exists-error";

@injectable()
class CreateBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
  ) {}

  async execute(
    businessData: CreateBusinessProps,
    userId: string,
  ): Promise<Business> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessByCnpj = await this.business.findBusinessByCnpj(
      businessData.cnpj,
    );

    if (findBusinessByCnpj) {
      throw new BusinessCnpjAlreadyExistsError();
    }

    const findBusinessByCorporateReason =
      await this.business.findBusinessByCorporateReason(
        businessData.corporate_reason,
      );

    if (findBusinessByCorporateReason) {
      throw new BusinessCorporateReasonAlreadyExistsError();
    }

    if (businessData.erp_code) {
      const findBusinessByErpcode = await this.business.findBusinessByErpcode(
        businessData.erp_code,
      );

      if (findBusinessByErpcode) {
        throw new BusinessErpCodeAlreadyExistsError();
      }
    }

    const findBusinessByEmail = await this.business.findBusinessByEmail(
      businessData.email,
    );

    if (findBusinessByEmail) {
      throw new BusinessEmailAlreadyExistsError();
    }

    const findBranchByCnpj = await this.branch.findBranchByCnpj(
      businessData.cnpj,
    );

    if (findBranchByCnpj) {
      throw new BranchCnpjAlreadyExistsError();
    }

    const findBranchByCorporateReason =
      await this.branch.findBranchByCorporateReason(
        businessData.corporate_reason,
      );

    if (findBranchByCorporateReason) {
      throw new BranchNameAlreadyExistsError();
    }

    if (businessData.erp_code) {
      const findBranchByErpCode = await this.branch.findBranchByErpCode(
        businessData.erp_code,
      );

      if (findBranchByErpCode) {
        throw new BranchErpCodeAlreadyExistsError();
      }
    }

    const findBranchByEmail = await this.branch.findBranchByEmail(
      businessData.email,
    );

    if (findBranchByEmail) {
      throw new BranchEmailAlreadyExistsError();
    }

    try {
      const businessCreated = await this.business.createBusiness(businessData);
      const branchData = {
        ...businessData,
        businessId: businessCreated.id as string,
      };

      await this.branch.createBranch(branchData);
      return businessCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar a empresa! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateBusinessUseCase };

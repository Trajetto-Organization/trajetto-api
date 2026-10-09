import { inject, injectable } from "tsyringe";
import { assertCallerRole } from "../errors/business-role-guard";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { Business, CreateBusinessProps } from "../../dtos/business-dto";
import { AppError } from "@/shared/errors/AppError";
import { NotificationService } from "@/shared/services/notification-service";

import { BusinessEmailAlreadyExistsError } from "../errors/business-email-already-exists-error";
import { BusinessErpCodeAlreadyExistsError } from "../errors/business-erp-code-already-exists-error";

import { BusinessCorporateReasonAlreadyExistsError } from "../errors/business-corporate-reason-already-exists-error";
import { BusinessCnpjAlreadyExistsError } from "../errors/business-cnpj-already-exists-error";

import { BranchCnpjAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-cnpj-already-exists-error";
import { businessUniqueViolation } from "../errors/business-unique-violation";
import { branchUniqueViolation } from "@/modules/branch/usecases/errors/branch-unique-violation";

import database from "@/../infra/database";

@injectable()
class CreateBusinessUseCase {
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
    businessData: CreateBusinessProps,
    userId: string,
  ): Promise<Business> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // MASTER-only, like the route: see assertCallerRole.
    assertCallerRole(findUser, ["MASTER"]);

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

    // No branch name, e-mail or ERP-code check: those are unique per
    // company (decision 8.1), and a company being created has no branches
    // yet. Looked up globally, another carrier's branch blocked this
    // onboarding and told the MASTER a stranger's data.

    try {
      // The company and its head office are one fact: they commit together,
      // or a failed head office leaves a company without one.
      const businessCreated = await database.$transaction(async (tx) => {
        const created = await this.business
          .createBusiness(businessData, tx)
          .catch((error: unknown) => {
            // Another create took the value after the lookups above: a 409.
            throw businessUniqueViolation(error) ?? error;
          });

        // The head office is a branch of the same data; the zone belongs to
        // the company alone (the branch table has no such column).
        const { timezone: _timezone, ...headOffice } = businessData;

        await this.branch
          .createBranch({ ...headOffice, businessId: created.id as string }, tx)
          .catch((error: unknown) => {
            throw branchUniqueViolation(error) ?? error;
          });

        return created;
      });

      this.notificationService.createActivityIfEnabled({
        type: "Empresa",
        action: "create",
        entityId: businessCreated.id as string,
        description: `Empresa ${businessCreated.corporate_reason} cadastrada`,
        status: "Completo",
        performedBy: userId,
        businessId: businessCreated.id as string,
      });

      return businessCreated;
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar criar a empresa! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateBusinessUseCase };

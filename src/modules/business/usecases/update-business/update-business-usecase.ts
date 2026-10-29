import { inject, injectable } from "tsyringe";
import { assertCallerRole } from "../errors/business-role-guard";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { Business, UpdateBusinessProps } from "../../dtos/business-dto";

import { NotificationService } from "@/shared/services/notification-service";
import { sendCatalogChangedEvent } from "@/websocket";

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
import { businessUniqueViolation } from "../errors/business-unique-violation";
import { branchUniqueViolation } from "@/modules/branch/usecases/errors/branch-unique-violation";

import database from "@/../infra/database";

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

    // MASTER-only, like the route: see assertCallerRole.
    assertCallerRole(findUser, ["MASTER"]);

    const existingBusiness = await this.business.findBusinessById(businessId);

    if (!existingBusiness) {
      throw new BusinessNotFoundError();
    }

    // The head office: the branch carrying the company's own CNPJ. Only if
    // it is this company's — the CNPJ lookup is platform-wide.
    const branchWithCnpj = await this.branch.findBranchByCnpj(
      existingBusiness.cnpj,
    );
    const matrixBranch =
      branchWithCnpj?.businessId === businessId ? branchWithCnpj : null;

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

    // The head office mirrors the company, so its new name and e-mail must
    // be free among THIS company's other branches (the per-company uniques,
    // decision 8.1) — other carriers' branches do not count and are not
    // looked at.
    if (businessData.corporate_reason) {
      const findBranchByCorporateReason =
        await this.branch.findBranchByCorporateReason(
          businessId,
          businessData.corporate_reason,
        );

      if (
        findBranchByCorporateReason &&
        (!matrixBranch || findBranchByCorporateReason.id !== matrixBranch.id)
      ) {
        throw new BranchNameAlreadyExistsError();
      }
    }

    // Among this company's own branches only (the ERP code is unique per
    // company); the head office carries the company's code and is excluded.
    if (businessData.erp_code) {
      const findBranchByErpCode = await this.branch.findBranchByErpCode(
        businessId,
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
        businessId,
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
      // Mapped here and only here: a unique violation on the head-office
      // write below is a branch conflict, not BUSINESS_*_TAKEN.
      // The company and its head office commit together: a head-office 409
      // must not leave the company row already changed.
      const businessUpdated = await database.$transaction(async (tx) => {
        const updated = await this.business
          .updateBusiness({ businessData, businessId }, tx)
          .catch((error: unknown) => {
            // Another save took the value after the lookups above: a 409.
            throw businessUniqueViolation(error) ?? error;
          });

        // Also update the head office. The zone is the company's alone (the
        // branch table has no such column: passing it failed the update).
        if (matrixBranch) {
          const { timezone: _timezone, ...headOffice } = businessData;

          await this.branch
            .updateBranch(
              { branchData: headOffice, branchId: matrixBranch.id },
              tx,
            )
            .catch((error: unknown) => {
              // A sibling branch took the value after the lookups: the
              // branch's own 409, not a company one.
              throw branchUniqueViolation(error) ?? error;
            });
        }

        return updated;
      });

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

      if (matrixBranch) sendCatalogChangedEvent(businessId, "branch");

      return businessUpdated;
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar atualizar a empresa! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateBusinessUseCase };

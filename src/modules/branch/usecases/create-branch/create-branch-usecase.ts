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

import { branchUniqueViolation } from "../errors/branch-unique-violation";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { sendCatalogChangedEvent } from "@/websocket";
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

    // The route guard pins the path to the session; the rule also lives
    // with the use case for any other caller.
    assertTenantAccess(findUser, businessId);

    // Uniqueness inside THIS company (decision 8.1): another carrier may
    // have a branch with the same name, e-mail or ERP code, and it is not
    // ours to say so. Nothing here looks at other companies' rows except the
    // CNPJ, which is national, and its answer names nobody.
    const findBranchByCorporateReason =
      await this.branch.findBranchByCorporateReason(
        businessId,
        branchData.corporate_reason,
      );

    if (findBranchByCorporateReason) {
      throw new BranchNameAlreadyExistsError();
    }

    if (branchData.erp_code) {
      const findBranchByErpCode = await this.branch.findBranchByErpCode(
        businessId,
        branchData.erp_code,
      );

      if (findBranchByErpCode) {
        throw new BranchErpCodeAlreadyExistsError();
      }
    }

    const findBranchByEmail = await this.branch.findBranchByEmail(
      businessId,
      branchData.email,
    );

    if (findBranchByEmail) {
      throw new BranchEmailAlreadyExistsError();
    }

    // The CNPJ is one legal establishment: taken by any branch, or by a
    // company other than this one (the head office carries its own company's
    // CNPJ). Neutral either way.
    const findBranchByCnpj = await this.branch.findBranchByCnpj(
      branchData.cnpj,
    );

    if (findBranchByCnpj) {
      throw new BranchCnpjAlreadyExistsError();
    }

    if (branchData.cnpj !== findBusiness.cnpj) {
      const findOtherBusinessByCnpj = await this.business.findBusinessByCnpj(
        branchData.cnpj,
      );

      if (
        findOtherBusinessByCnpj &&
        findOtherBusinessByCnpj.id !== businessId
      ) {
        throw new BranchCnpjAlreadyExistsError();
      }
    }

    let branchCreated: Branch;

    try {
      branchCreated = await this.branch.createBranch({
        ...branchData,
        businessId,
      });
    } catch (error) {
      // Two requests that both passed the checks: the loser gets the same 409.
      const duplicate = branchUniqueViolation(error);

      if (duplicate) throw duplicate;

      throw new AppError(
        "Houve um erro ao tentar criar a filial! Por favor, tente novamente.",
        500,
      );
    }

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

    // After the write: open screens of this company refresh their pickers.
    sendCatalogChangedEvent(businessId, "branch");

    return branchCreated;
  }
}

export { CreateBranchUseCase };

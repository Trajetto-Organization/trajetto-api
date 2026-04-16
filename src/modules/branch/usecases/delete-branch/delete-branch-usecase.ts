import { inject, injectable } from "tsyringe";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Branch } from "../../dtos/branch-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "../errors/branch-not-found-error";

import { BranchNotBelongBusinessError } from "../errors/branch-not-belong-business-error";
import { BranchHasChildrenError } from "../errors/branch-has-children-error";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

const dependencyLabels: Record<string, string> = {
  vehicles: "veículo(s)",
  drivers: "motorista(s)",
  serviceOrders: "ordem(ns) de serviço",
  accountsPayable: "conta(s) a pagar",
  fines: "multa(s)",
  fuels: "abastecimento(s)",
  vehicleChecklists: "checklist(s) de veículo",
};

@injectable()
class DeleteBranchUseCase {
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

    // Validate child records before deletion
    const dependencies = await this.branch.countBranchDependencies(branchId);
    const details: string[] = [];

    for (const [key, count] of Object.entries(dependencies)) {
      if (count > 0) {
        const label = dependencyLabels[key] || key;
        details.push(`${count} ${label}`);
      }
    }

    if (details.length > 0) {
      throw new BranchHasChildrenError(`Existem ${details.join(", ")}.`);
    }

    try {
      const deletedBranch = await this.branch.deleteBranch(branchId);

      this.notificationService.createActivityIfEnabled({
        type: "Filial",
        action: "delete",
        entityId: deletedBranch.id,
        description: `Filial excluída: ${deletedBranch.corporate_reason} | CNPJ: ${deletedBranch.cnpj} | ID: ${deletedBranch.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId: businessId,
      });

      return deletedBranch;
    } catch (error) {
      if (error instanceof BranchHasChildrenError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar excluir a filial! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteBranchUseCase };

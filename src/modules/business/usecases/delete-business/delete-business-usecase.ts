import { inject, injectable } from "tsyringe";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { Business } from "../../dtos/business-dto";
import { AppError } from "@/shared/errors/AppError";
import { NotificationService } from "@/shared/services/notification-service";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { BusinessHasChildrenError } from "@/modules/business/usecases/errors/business-has-children-error";

@injectable()
class DeleteBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(businessId: string, userId: string): Promise<Business> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const existingBusiness = await this.business.findBusinessById(businessId);

    if (!existingBusiness) {
      throw new BusinessNotFoundError();
    }

    // Validate child records before deletion
    const dependencies =
      await this.business.countBusinessDependencies(businessId);
    const details: string[] = [];

    if (dependencies.branches > 0) {
      details.push(`${dependencies.branches} filial(is) vinculada(s)`);
    }

    if (dependencies.users > 0) {
      details.push(`${dependencies.users} usuário(s) vinculado(s)`);
    }

    if (dependencies.drivers > 0) {
      details.push(`${dependencies.drivers} motorista(s) vinculado(s)`);
    }

    if (details.length > 0) {
      throw new BusinessHasChildrenError(`Existem ${details.join(", ")}.`);
    }

    try {
      const businessDeleted = await this.business.deleteBusiness(businessId);

      this.notificationService.createActivityIfEnabled({
        type: "Empresa",
        action: "delete",
        entityId: businessId,
        description: `Empresa ${businessDeleted.corporate_reason} excluída`,
        status: "Deletado",
        performedBy: userId,
        businessId: null,
        tenantName: businessDeleted.corporate_reason,
      });

      return businessDeleted;
    } catch (error) {
      if (error instanceof BusinessHasChildrenError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar deletar a empresa! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteBusinessUseCase };

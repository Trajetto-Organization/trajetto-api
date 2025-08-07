import { inject, injectable } from "tsyringe";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Supplier } from "../../dtos/supplier-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { SupplierNotFoundError } from "../errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "../errors/supplier-not-belong-business-error";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class DeleteSupplierUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("SupplierRepository")
    private supplier: ISupplierRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    supplierId: string,
    businessId: string,
    userId: string,
  ): Promise<Supplier> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findSupplier = await this.supplier.findSupplierById(supplierId);

    if (!findSupplier) {
      throw new SupplierNotFoundError();
    }

    if (findSupplier.businessId !== businessId) {
      throw new SupplierNotBelongBusinessError();
    }

    try {
      const deletedSupplier = await this.supplier.deleteSupplier(supplierId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Fornecedor",
        action: "delete",
        entityId: deletedSupplier.id,
        description: `Fornecedor excluído: ${deletedSupplier.name} | CNPJ: ${deletedSupplier.cnpj} | ID: ${deletedSupplier.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId: businessId,
      });

      return deletedSupplier;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir o fornecedor! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteSupplierUseCase };

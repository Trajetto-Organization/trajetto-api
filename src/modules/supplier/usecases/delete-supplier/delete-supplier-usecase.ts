import { inject, injectable } from "tsyringe";
import { foreignRecordRefusal } from "@/modules/middlewares/tenant-authorization";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Supplier } from "../../dtos/supplier-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { SupplierNotFoundError } from "../errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "../errors/supplier-not-belong-business-error";

import { SupplierInUseError } from "../errors/supplier-in-use-error";
import { sendCatalogChangedEvent } from "@/websocket";

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
      // A tenant user reaches here only with their own company in the path
      // (the tenant guard), so a mismatch is someone else's row: 404, like
      // an id that does not exist.
      throw foreignRecordRefusal(
        findUser,
        () => new SupplierNotBelongBusinessError(),
        () => new SupplierNotFoundError(),
      );
    }

    // Refused with the counts, the way vehicles, drivers and shippers are:
    // the person needs to know what still depends on it.
    const references = await this.supplier.countSupplierReferences(supplierId);

    if (
      references.serviceOrders + references.parts + references.accountsPayable >
      0
    ) {
      throw new SupplierInUseError(references);
    }

    // The delete re-checks "nothing references it" under a row lock in its
    // own transaction; a link made since the count above makes it delete
    // nothing (the count above only words the refusal).
    const deletedSupplier = await this.supplier.deleteUnreferencedSupplier(
      supplierId,
      businessId,
    );

    if (!deletedSupplier) {
      const now = await this.supplier.countSupplierReferences(supplierId);

      // Nothing references it and nothing was deleted: someone else did.
      if (now.serviceOrders + now.parts + now.accountsPayable === 0) {
        throw new SupplierNotFoundError();
      }

      throw new SupplierInUseError(now);
    }

    sendCatalogChangedEvent(businessId, "supplier");

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
  }
}

export { DeleteSupplierUseCase };

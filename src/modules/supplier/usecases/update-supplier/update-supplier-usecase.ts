import { inject, injectable } from "tsyringe";
import { foreignRecordRefusal } from "@/modules/middlewares/tenant-authorization";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Supplier, UpdateSupplierFields } from "../../dtos/supplier-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { SupplierNotFoundError } from "../errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "../errors/supplier-not-belong-business-error";

import { AppError } from "@/shared/errors/AppError";
import { isUniqueViolation } from "@/shared/http/idempotency-key";
import { sendCatalogChangedEvent } from "@/websocket";

import { assertSupplierIsUnique } from "../supplier-uniqueness";

@injectable()
class UpdateSupplierUseCase {
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
    supplierData: UpdateSupplierFields,
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

    // For the MASTER too. A mismatch used to be read as "move it": the row
    // was rewritten to the company in the path while its parts and service
    // orders stayed behind, linked across tenants.
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

    // Only what changes is checked: the row meeting its own name is fine.
    const uniqueness = {
      businessId,
      exceptId: supplierId,
      name:
        supplierData.name && supplierData.name !== findSupplier.name
          ? supplierData.name
          : null,
      cnpj:
        supplierData.cnpj && supplierData.cnpj !== findSupplier.cnpj
          ? supplierData.cnpj
          : null,
      email:
        supplierData.email && supplierData.email !== findSupplier.email
          ? supplierData.email
          : null,
    };

    await assertSupplierIsUnique(this.supplier, uniqueness);

    let updatedSupplier: Supplier;

    try {
      updatedSupplier = await this.supplier.updateSupplier({
        supplierData,
        supplierId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        await assertSupplierIsUnique(this.supplier, uniqueness);
      }

      throw new AppError(
        "Houve um erro ao tentar atualizar o fornecedor! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "supplier");

    // Process activity asynchronously without blocking the main flow
    this.notificationService.createActivityIfEnabled({
      type: "Fornecedor",
      action: "update",
      entityId: updatedSupplier.id,
      description: `Fornecedor atualizado com sucesso: ${updatedSupplier.name} | CNPJ: ${updatedSupplier.cnpj} | ID: ${updatedSupplier.id}`,
      status: "Atualizado",
      performedBy: userId,
      businessId: businessId,
    });

    return updatedSupplier;
  }
}

export { UpdateSupplierUseCase };

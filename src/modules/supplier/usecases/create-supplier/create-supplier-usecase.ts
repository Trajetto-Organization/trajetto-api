import { inject, injectable } from "tsyringe";
import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Supplier, CreateSupplierProps } from "../../dtos/supplier-dto";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { isUniqueViolation } from "@/shared/http/idempotency-key";
import { sendCatalogChangedEvent } from "@/websocket";

import { assertSupplierIsUnique } from "../supplier-uniqueness";

@injectable()
class CreateSupplierUseCase {
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
    supplierData: CreateSupplierProps,
    userId: string,
  ): Promise<Supplier> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      supplierData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    await assertSupplierIsUnique(this.supplier, {
      businessId: supplierData.businessId,
      name: supplierData.name,
      cnpj: supplierData.cnpj,
      email: supplierData.email,
    });

    let supplierCreated: Supplier;

    try {
      supplierCreated = await this.supplier.createSupplier(supplierData);
    } catch (error) {
      // A unique index on the table (FLEET-DUP-1) answers the race the
      // lookups above cannot: two identical submissions at once.
      if (isUniqueViolation(error)) {
        await assertSupplierIsUnique(this.supplier, {
          businessId: supplierData.businessId,
          name: supplierData.name,
          cnpj: supplierData.cnpj,
          email: supplierData.email,
        });
      }

      throw new AppError(
        "Houve um erro ao tentar criar o fornecedor! Por favor, tente novamente.",
        500,
      );
    }

    // After the row is committed: other open screens refresh their pickers.
    sendCatalogChangedEvent(supplierData.businessId, "supplier");

    // Process activity asynchronously without blocking the main flow
    this.notificationService.createActivityIfEnabled({
      type: "Fornecedor",
      action: "create",
      entityId: supplierCreated.id,
      description: `Fornecedor criado com sucesso: ${supplierCreated.name} | CNPJ: ${supplierCreated.cnpj} | ID: ${supplierCreated.id}`,
      status: "Completo",
      performedBy: userId,
      businessId: supplierData.businessId,
    });

    return supplierCreated;
  }
}

export { CreateSupplierUseCase };

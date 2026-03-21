import { inject, injectable } from "tsyringe";
import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Supplier, CreateSupplierProps } from "../../dtos/supplier-dto";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { NotificationService } from "@/shared/services/notification-service";

import { SupplierNameAlreadyExistsError } from "../errors/supplier-name-already-exists-error";
import { SupplierCnpjAlreadyExistsError } from "../errors/supplier-cnpj-already-exists-error";

import { SupplierEmailAlreadyExistsError } from "../errors/supplier-email-already-exists-error";
import { AppError } from "@/shared/errors/AppError";

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

    const findSupplierByName =
      await this.supplier.findSupplierByNameAndBusinessId(
        supplierData.name,
        supplierData.businessId,
      );

    if (findSupplierByName) {
      throw new SupplierNameAlreadyExistsError();
    }

    const findSupplierByCnpj =
      await this.supplier.findSupplierByCnpjAndBusinessId(
        supplierData.cnpj,
        supplierData.businessId,
      );

    if (findSupplierByCnpj) {
      throw new SupplierCnpjAlreadyExistsError();
    }

    if (supplierData.email) {
      const findSupplierByEmail = await this.supplier.findSupplierByEmail(
        supplierData.email,
      );

      if (findSupplierByEmail) {
        throw new SupplierEmailAlreadyExistsError();
      }
    }

    try {
      const supplierCreated = await this.supplier.createSupplier(supplierData);

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
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o fornecedor! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateSupplierUseCase };

import { inject, injectable } from "tsyringe";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { Supplier } from "../../dtos/supplier-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { SupplierNotFoundError } from "../errors/supplier-not-found-error";
import { SupplierNameAlreadyExistsError } from "../errors/supplier-name-already-exists-error";

import { SupplierCnpjAlreadyExistsError } from "../errors/supplier-cnpj-already-exists-error";
import { SupplierEmailAlreadyExistsError } from "../errors/supplier-email-already-exists-error";

import { SupplierNotBelongBusinessError } from "../errors/supplier-not-belong-business-error";
import { AppError } from "@/shared/errors/AppError";

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
    supplierData: any,
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

    if (findSupplier.businessId !== businessId && findUser.role !== "MASTER") {
      throw new SupplierNotBelongBusinessError();
    }

    if (supplierData.name || businessId !== findSupplier.businessId) {
      const nameToCheck = supplierData.name || findSupplier.name;

      const findSupplierByName =
        await this.supplier.findSupplierByNameAndBusinessId(
          nameToCheck,
          businessId,
        );

      if (findSupplierByName && findSupplierByName.id !== supplierId) {
        throw new SupplierNameAlreadyExistsError();
      }
    }

    if (supplierData.cnpj && supplierData.cnpj !== findSupplier.cnpj) {
      const findSupplierByCnpj =
        await this.supplier.findSupplierByCnpjAndBusinessId(
          supplierData.cnpj,
          businessId,
        );

      if (findSupplierByCnpj && findSupplierByCnpj.id !== supplierId) {
        throw new SupplierCnpjAlreadyExistsError();
      }
    }

    if (supplierData.email && supplierData.email !== findSupplier.email) {
      const findSupplierByEmail = await this.supplier.findSupplierByEmail(
        supplierData.email,
      );

      if (findSupplierByEmail && findSupplierByEmail.id !== supplierId) {
        throw new SupplierEmailAlreadyExistsError();
      }
    }

    try {
      const updatedSupplier = await this.supplier.updateSupplier({
        supplierData: {
          ...supplierData,
          businessId,
        },
        supplierId,
      });

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
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o fornecedor! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateSupplierUseCase };

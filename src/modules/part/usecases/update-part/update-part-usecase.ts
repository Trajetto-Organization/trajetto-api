import { inject, injectable } from "tsyringe";

import { IPartRepository } from "@/modules/part/repositories/IPart-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { PartNotFoundError } from "../errors/part-not-found-error";
import { PartAlreadyExistsError } from "../errors/part-already-exists-error";

import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";
import { PartNotBelongError } from "../errors/part-not-belong-error";

import { NotificationService } from "@/shared/services/notification-service";
import { formatCurrency } from "@/config/format-values";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { Part, UpdatePartProps } from "../../dtos/part-dto";

@injectable()
class UpdatePartUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("SupplierRepository")
    private supplier: ISupplierRepository,
    @inject("PartRepository")
    private part: IPartRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    partData: UpdatePartProps,
    partId: string,
    userId: string,
    currentBusinessId: string,
  ): Promise<Part> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness =
      await this.business.findBusinessById(currentBusinessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findPartById = await this.part.findPartById(partId);

    if (!findPartById) {
      throw new PartNotFoundError();
    }

    // If you are changing the company
    if (partData.businessId) {
      // Check if the new company exists
      const findNewBusiness = await this.business.findBusinessById(
        partData.businessId,
      );

      if (!findNewBusiness) {
        throw new BusinessNotFoundError();
      }
    } else if (findPartById.businessId !== currentBusinessId) {
      // If you are not changing company, check access to current company
      throw new PartNotBelongError();
    }

    // Check supplier
    if (partData.supplierId) {
      const findSupplier = await this.supplier.findSupplierById(
        partData.supplierId,
      );

      if (!findSupplier) {
        throw new SupplierNotFoundError();
      }

      // Check whether the supplier belongs to the new company (if any) or the current company
      const targetBusinessId = partData.businessId || currentBusinessId;

      if (findSupplier.businessId !== targetBusinessId) {
        throw new SupplierNotBelongBusinessError();
      }
    }

    // Check duplicate description
    if (
      partData.description &&
      partData.description !== findPartById.description
    ) {
      // Check with the destination company or the current one
      const targetBusinessId = partData.businessId || currentBusinessId;
      const findPartByDescription = await this.part.findPartByDescription(
        partData.description,
        targetBusinessId,
      );

      if (findPartByDescription) {
        throw new PartAlreadyExistsError();
      }
    }

    try {
      const partUpdated = await this.part.updatePart({
        partData,
        partId,
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Peça",
        action: "update",
        entityId: partUpdated.id,
        description: `Peça atualizada com sucesso: ${partUpdated.description} | Preço: ${formatCurrency(Number(partUpdated.unit_price))} | ID: ${partUpdated.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId: currentBusinessId,
      });

      return partUpdated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a peça! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdatePartUseCase };

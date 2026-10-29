import { inject, injectable } from "tsyringe";

import { IPartRepository } from "@/modules/part/repositories/IPart-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { AppError } from "@/shared/errors/AppError";
import { isUniqueViolation } from "@/shared/http/idempotency-key";

import { sendCatalogChangedEvent } from "@/websocket";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { PartNotFoundError } from "../errors/part-not-found-error";
import { PartAlreadyExistsError } from "../errors/part-already-exists-error";

import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";
import { PartBusinessReadOnlyError } from "../errors/part-business-read-only-error";

import { NotificationService } from "@/shared/services/notification-service";
import { formatCurrency } from "@/shared/utils/format-values";

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

    /**
     * The part must be this company's, ALWAYS, and another company's part
     * answers like a missing one (decision 11.3).
     *
     * This used to live inside an `else`: any `businessId` in the body
     * took the other branch and the ownership check never ran, so another
     * company's part was moved onto the caller's. A check the caller can
     * switch off is not a check.
     */
    if (!findPartById || findPartById.businessId !== currentBusinessId) {
      throw new PartNotFoundError();
    }

    // Moving a part between companies is a business decision with history
    // behind it, not a form field: refused, with the part left as it was.
    if (partData.businessId && partData.businessId !== currentBusinessId) {
      throw new PartBusinessReadOnlyError();
    }

    // Check supplier
    if (partData.supplierId) {
      const findSupplier = await this.supplier.findSupplierById(
        partData.supplierId,
      );

      if (!findSupplier) {
        throw new SupplierNotFoundError();
      }

      if (findSupplier.businessId !== currentBusinessId) {
        throw new SupplierNotBelongBusinessError();
      }
    }

    // Another part of this company with the same description. The part
    // itself is left out: "filtro" → "Filtro" found the part being edited
    // and refused its own rename.
    if (partData.description) {
      const duplicate = await this.part.findPartByDescription(
        partData.description,
        currentBusinessId,
        partId,
      );

      if (duplicate) {
        throw new PartAlreadyExistsError();
      }
    }

    let partUpdated: Part;

    try {
      partUpdated = await this.part.updatePart({
        partData,
        partId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new PartAlreadyExistsError();

      throw new AppError(
        "Houve um erro ao tentar atualizar a peça! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(currentBusinessId, "part");

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
  }
}

export { UpdatePartUseCase };

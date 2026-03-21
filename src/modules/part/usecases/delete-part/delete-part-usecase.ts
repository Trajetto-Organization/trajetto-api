import { inject, injectable } from "tsyringe";

import { IPartRepository } from "@/modules/part/repositories/IPart-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { PartNotBelongServiceOrderError } from "../errors/part-not-belong-service-order-error";
import { PartNotFoundError } from "../errors/part-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { formatCurrency } from "@/shared/utils/format-values";

import { Part } from "../../dtos/part-dto";
import { PartHasAssociatedServiceOrderPartsError } from "../errors/part-has-associated-service-order-parts-error";

@injectable()
class DeletePartUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("PartRepository")
    private part: IPartRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    partId: string,
    userId: string,
    businessId: string,
  ): Promise<Part> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findPartById = await this.part.findPartById(partId);

    if (!findPartById) {
      throw new PartNotFoundError();
    }

    if (findPartById.businessId !== businessId) {
      throw new PartNotBelongServiceOrderError();
    }

    const associatedServiceOrderParts =
      await this.part.findServiceOrderPartsByPartId(partId);

    if (associatedServiceOrderParts.length > 0) {
      throw new PartHasAssociatedServiceOrderPartsError(
        associatedServiceOrderParts.length,
      );
    }

    try {
      const partDeleted = await this.part.deletePart(partId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Peça",
        action: "delete",
        entityId: partDeleted.id,
        description: `Peça excluída: ${partDeleted.description} | Preço: ${formatCurrency(Number(partDeleted.unit_price))} | ID: ${partDeleted.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId: businessId,
      });

      return partDeleted;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar a peça! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeletePartUseCase };

import { inject, injectable } from "tsyringe";
import { Prisma } from "@prisma/client";

import { IPartRepository } from "@/modules/part/repositories/IPart-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { PartNotFoundError } from "../errors/part-not-found-error";

import { sendCatalogChangedEvent } from "@/websocket";

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

    // Another company's part answers like a missing one: "não pertence a
    // esta empresa" confirmed the id exists elsewhere (decision 11.3).
    if (!findPartById || findPartById.businessId !== businessId) {
      throw new PartNotFoundError();
    }

    // A count, not the lines themselves: only the number is shown.
    const usage = await this.part.countServiceOrderPartsByPartId(partId);

    if (usage > 0) {
      throw new PartHasAssociatedServiceOrderPartsError(usage);
    }

    let partDeleted: Part;

    try {
      partDeleted = await this.part.deletePart(partId);
    } catch (error) {
      // A line saved between the count and the delete: the foreign key
      // (RESTRICT) refuses it, and that is the same "in use" answer, not a
      // server fault.
      if (isForeignKeyViolation(error)) {
        const lines = await this.part.countServiceOrderPartsByPartId(partId);

        throw new PartHasAssociatedServiceOrderPartsError(Math.max(lines, 1));
      }

      throw new AppError(
        "Houve um erro ao tentar deletar a peça! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "part");

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
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2003"
  );
}

export { DeletePartUseCase };

import { inject, injectable } from "tsyringe";
import { IPartRepository } from "@/modules/part/repositories/IPart-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { PartAlreadyExistsError } from "../errors/part-already-exists-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";

import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";
import { Part, CreatePartProps } from "../../dtos/part-dto";

import { NotificationService } from "@/shared/services/notification-service";
import { formatCurrency } from "@/shared/utils/format-values";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class CreatePartUseCase {
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

  async execute(partData: CreatePartProps, userId: string): Promise<Part> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      partData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (partData.supplierId) {
      const findSupplier = await this.supplier.findSupplierById(
        partData.supplierId,
      );

      if (!findSupplier) {
        throw new SupplierNotFoundError();
      }

      if (findSupplier.businessId !== partData.businessId) {
        throw new SupplierNotBelongBusinessError();
      }
    }

    const findPartByDescription = await this.part.findPartByDescription(
      partData.description,
      partData.businessId,
    );

    if (findPartByDescription) {
      throw new PartAlreadyExistsError();
    }

    try {
      const partCreated = await this.part.createPart(partData);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Peça",
        action: "create",
        entityId: partCreated.id,
        description: `Peça criada com sucesso: ${partCreated.description} | Preço: ${formatCurrency(Number(partCreated.unit_price))} | ID: ${partCreated.id}`,
        status: "Completo",
        performedBy: userId,
        businessId: partData.businessId,
      });

      return partCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar a peça! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreatePartUseCase };

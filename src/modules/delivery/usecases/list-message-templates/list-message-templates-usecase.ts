import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryMessageTemplateRepository } from "../../repositories/IDelivery-message-template-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { DeliveryMessageTemplateRecord } from "../../repositories/IDelivery-message-template-repository";

interface ListMessageTemplatesRequest {
  userId: string;
  businessId?: string;
}

@injectable()
class ListMessageTemplatesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryMessageTemplateRepository")
    private templates: IDeliveryMessageTemplateRepository,
  ) {}

  async execute({
    userId,
    businessId,
  }: ListMessageTemplatesRequest): Promise<{
    data: DeliveryMessageTemplateRecord[];
    total: number;
  }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    const data = await this.templates.listByBusiness(resolvedBusinessId);

    return { data, total: data.length };
  }
}

export { ListMessageTemplatesUseCase };

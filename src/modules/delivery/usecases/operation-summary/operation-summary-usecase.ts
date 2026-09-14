import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import { OperationSummary } from "../../dtos/delivery-dto";

interface OperationSummaryRequest {
  userId: string;
  businessId?: string;
}

/**
 * The monitoring panel's numbers: what the dispatcher still owes a route,
 * who is on the street, what the day produced. Manager surface — a driver
 * token is refused rather than shown the whole operation.
 */
@injectable()
class OperationSummaryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
  ) {}

  async execute({
    userId,
    businessId,
  }: OperationSummaryRequest): Promise<OperationSummary> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // The driver permission table opens delivery_manage for the app's own
    // routes; the whole-operation view stays with the manager.
    if (findUser.driverId) {
      throw new AppError(
        "Painéis de monitoramento são superfície do gestor.",
        403,
        "DRIVER_CANNOT_VIEW_PANELS",
      );
    }

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    try {
      return await this.delivery.operationSummary(resolvedBusinessId);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Não foi possível montar o resumo da operação!",
        500,
      );
    }
  }
}

export { OperationSummaryUseCase };

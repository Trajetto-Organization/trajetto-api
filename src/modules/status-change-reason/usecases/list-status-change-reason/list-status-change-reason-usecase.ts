import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IStatusChangeReasonRepository } from "../../repositories/IStatus-change-reason-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import { ListStatusChangeReasonsResult } from "../../dtos/status-change-reason-dto";

interface ListStatusChangeReasonsRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
}

@injectable()
class ListStatusChangeReasonUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("StatusChangeReasonRepository")
    private reason: IStatusChangeReasonRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
  }: ListStatusChangeReasonsRequest): Promise<ListStatusChangeReasonsResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // MASTER picks the company explicitly; everyone else is pinned to their
    // own — the same resolution every list route in the app uses.
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
      // The cards describe the whole catalogue, never the page on screen.
      const [result, summary] = await Promise.all([
        this.reason.listStatusChangeReasons({
          page,
          pageSize,
          businessId: resolvedBusinessId,
          search,
        }),
        this.reason.countStatusChangeReasonsSummary(resolvedBusinessId),
      ]);

      return { ...result, meta: summary };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar os motivos! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListStatusChangeReasonUseCase };

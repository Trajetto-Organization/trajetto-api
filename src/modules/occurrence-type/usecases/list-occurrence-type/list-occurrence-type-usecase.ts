import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "../../repositories/IOccurrence-type-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import { ListOccurrenceTypesResult } from "../../dtos/occurrence-type-dto";

interface ListOccurrenceTypesRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
}

@injectable()
class ListOccurrenceTypeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OccurrenceTypeRepository")
    private occurrenceType: IOccurrenceTypeRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
  }: ListOccurrenceTypesRequest): Promise<ListOccurrenceTypesResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // MASTER picks the company explicitly; everyone else is pinned to
    // their own — same resolution every list route in the app uses.
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
      const [result, summary] = await Promise.all([
        this.occurrenceType.listOccurrenceTypes({
          page,
          pageSize,
          businessId: resolvedBusinessId,
          search,
        }),
        this.occurrenceType.countOccurrenceTypesSummary(resolvedBusinessId),
      ]);

      return { ...result, meta: summary };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Não foi possível recuperar os tipos de ocorrência!",
        500,
      );
    }
  }
}

export { ListOccurrenceTypeUseCase };

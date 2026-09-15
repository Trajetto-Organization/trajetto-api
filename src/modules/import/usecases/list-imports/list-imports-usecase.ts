import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IImportRepository } from "../../repositories/IImport-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { ListImportsResult } from "../../dtos/import-dto";

interface ListImportsRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
}

/**
 * The uploads a company has made, newest first.
 *
 * Exists so the report survives the request that produced it: "qual das
 * duzentas falhou?" is asked hours later, by somebody who did not do the
 * upload and cannot re-run it to find out.
 */
@injectable()
class ListImportsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ImportRepository")
    private importRepository: IImportRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
  }: ListImportsRequest): Promise<ListImportsResult> {
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

    return this.importRepository.listImports({
      businessId: resolvedBusinessId,
      page,
      pageSize,
    });
  }
}

export { ListImportsUseCase };

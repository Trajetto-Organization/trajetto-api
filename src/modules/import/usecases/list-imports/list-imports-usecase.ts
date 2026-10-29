import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IImportRepository } from "../../repositories/IImport-repository";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  ImportSource,
  ImportStatus,
  ListImportsResult,
} from "../../dtos/import-dto";
import { summarizeImportList, type ImportSortKey } from "./import-list";

interface ListImportsRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  includeReport?: boolean;
  sort?: ImportSortKey;
  order?: SortOrder;
  statuses?: ImportStatus[];
  sources?: ImportSource[];
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
    includeReport,
    sort,
    order,
    statuses,
    sources,
  }: ListImportsRequest): Promise<ListImportsResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw callerNotFound();

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    const { data, groups } = await this.importRepository.listImports({
      businessId: resolvedBusinessId,
      page,
      pageSize,
      includeReport,
      sort,
      order,
      statuses,
      sources,
    });

    // The filter counts over the whole company (decision 8.8).
    const { total, searchMeta } = summarizeImportList(groups, {
      statuses,
      sources,
    });

    return { data, total, meta: searchMeta };
  }
}

export { ListImportsUseCase };

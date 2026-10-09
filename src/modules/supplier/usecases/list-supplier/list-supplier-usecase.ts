import { inject, injectable } from "tsyringe";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";

import { Supplier } from "../../dtos/supplier-dto";
import {
  summarizeSupplierList,
  type BrazilianUf,
  type SupplierListSearchMeta,
  type SupplierSortKey,
} from "./supplier-list";

interface ListSupplierRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  ufs?: BrazilianUf[];
  sort?: SupplierSortKey;
  order?: SortOrder;
}

interface ListSupplierResponse {
  data: Supplier[];
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and the UF options. */
  searchMeta: SupplierListSearchMeta;
}

/**
 * One company's suppliers, with the cards and filters answered over the
 * whole company (decision 8.8). The MASTER names the company; there is no
 * "every company" list, which used to mix tenants on one page.
 */
@injectable()
class ListSupplierUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SupplierRepository")
    private supplier: ISupplierRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    ufs,
    sort,
    order,
  }: ListSupplierRequest): Promise<ListSupplierResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
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
      const result = await this.supplier.listSuppliers({
        page,
        pageSize,
        businessId: resolvedBusinessId,
        search,
        ufs,
        sort,
        order,
      });

      const { total, searchMeta } = summarizeSupplierList(result.stateCounts, {
        ufs,
      });

      return { data: result.data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar os fornecedores! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListSupplierUseCase };
export type { ListSupplierRequest, ListSupplierResponse };

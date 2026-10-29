import { inject, injectable } from "tsyringe";

import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { UploadService } from "@/shared/services/upload-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";

import {
  summarizeFuelList,
  type FuelListSearchMeta,
  type FuelSortKey,
} from "./fuel-list";

interface ListFuelRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  branchIds?: string[];
  vehicleIds?: string[];
  fuelTypeIds?: string[];
  sort?: FuelSortKey;
  order?: SortOrder;
}

interface ListFuelResponse {
  data: unknown[];
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and filter options. */
  searchMeta: FuelListSearchMeta;
}

/**
 * The refuelings of one company, ordered, filtered and summed by the server
 * over the whole company (decision 8.8) — the cards used to add up the ten
 * rows on screen and call it "Valor Total".
 *
 * The company is explicit: the MASTER names it (he used to get every
 * company's refuelings in one list), everyone else is pinned to their own. A
 * driver reads only their own refuelings (decision 4.4): `fuel_manage:read`
 * is granted so the app can show a driver's history, never the fleet's.
 */
@injectable()
class ListFuelUseCase {
  constructor(
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    branchIds,
    vehicleIds,
    fuelTypeIds,
    sort,
    order,
  }: ListFuelRequest): Promise<ListFuelResponse> {
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

    const facets = { branchIds, vehicleIds, fuelTypeIds };

    try {
      const result = await this.fuel.listFuels({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        driverId: findUser.driverId ?? undefined,
        search,
        ...facets,
      });

      const { total, searchMeta } = summarizeFuelList(
        result.groups,
        result.labels,
        facets,
      );

      // `getFileUrl` signs asynchronously (AWS SDK v3): wait for every one.
      const data = await Promise.all(
        result.data.map(async (fuel) => ({
          ...fuel,
          odometer_photo: fuel.odometer_photo
            ? await this.uploadService.getFileUrl(fuel.odometer_photo)
            : null,
        })),
      );

      return { data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar o abastecimento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListFuelUseCase };
export type { ListFuelRequest, ListFuelResponse };

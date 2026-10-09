import { inject, injectable } from "tsyringe";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";
import { permissionDenied } from "@/shared/errors/access-errors";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import type { SortOrder } from "@/shared/pagination/list-query";
import type { VehicleStatus } from "@/shared/vehicle/vehicle-rules";

import type { Vehicle } from "../../dtos/vehicle-dto";
import {
  summarizeVehicleList,
  type VehicleListSearchMeta,
  type VehicleSortKey,
} from "./vehicle-list";

interface ListVehicleRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  statuses?: VehicleStatus[];
  branchIds?: string[];
  sort?: VehicleSortKey;
  order?: SortOrder;
}

interface ListVehicleResponse {
  data: Vehicle[];
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and filter options. */
  searchMeta: VehicleListSearchMeta;
}

/**
 * The fleet table of ONE company, sorted, filtered and counted by the server
 * (decision 8.8).
 *
 * The MASTER names the company (the /admin selector); everyone else is
 * pinned to their own. It used to list every company's vehicles to a MASTER
 * with no filter, which was the only fleet screen that did.
 *
 * Drivers are refused (FLEET-VEH-6, decision 4.4): `vehicle_manage:read` is
 * theirs for the vehicle they drive, and this listing returned the whole
 * fleet with the other drivers' names and CNH. Their app reads its vehicles
 * through the search, which is scoped to them.
 */
@injectable()
class ListVehicleUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    statuses,
    branchIds,
    sort,
    order,
  }: ListVehicleRequest): Promise<ListVehicleResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (findUser.driverId) {
      throw permissionDenied(
        "Motoristas não listam a frota da empresa; os seus veículos estão no aplicativo.",
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
      const result = await this.vehicle.listVehicles({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        search,
        statuses,
        branchIds,
      });

      const { total, searchMeta } = summarizeVehicleList(
        result.statusCounts,
        result.branchCounts,
        { statuses },
      );

      return { data: result.data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar os veículos! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListVehicleUseCase };
export type { ListVehicleRequest, ListVehicleResponse };

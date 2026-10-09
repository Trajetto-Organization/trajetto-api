import { inject, injectable } from "tsyringe";
import { IVehicleTypeRepository } from "@/modules/vehicle-type/repositories/IVehicle-type-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import type { SortOrder } from "@/shared/pagination/list-query";

import { ListVehicleTypeResult } from "../../dtos/vehicle-type-dto";
import { summarizeVehicleTypeList, type VehicleTypeSortKey } from "./vehicle-type-list";

interface ListVehicleTypeRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: VehicleTypeSortKey;
  order?: SortOrder;
}

/**
 * The vehicle types of ONE company, sorted by the server (decision 8.8):
 * the MASTER names the company (the /admin selector), everyone else is
 * pinned to their own. It used to list every company's types to a MASTER.
 */
@injectable()
class ListVehicleTypeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleTypeRepository")
    private vehicleType: IVehicleTypeRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    sort,
    order,
  }: ListVehicleTypeRequest): Promise<ListVehicleTypeResult> {
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
      const { data, total, usage } = await this.vehicleType.listVehicleTypes({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        search,
      });

      // The cards count the whole search of the company (decision 8.8),
      // never the page on screen.
      return { data, total, meta: summarizeVehicleTypeList(usage) };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar os tipos de veículos! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListVehicleTypeUseCase };

import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { decidePermission } from "@/modules/middlewares/verify-permission";
import { hasModule } from "@/shared/entitlements/entitlement-service";
import { isModuleEnabled } from "@/shared/entitlements/entitlement-rules";
import { businessMonthKey, businessMonthRange } from "@/shared/time/business-day";
import { loadBusinessTimeZone } from "@/shared/time/business-time-zone";
import type { SortOrder } from "@/shared/pagination/list-query";

import type { User } from "@/modules/user/dtos/user-dto";

import { ListFuelTypeResult } from "../../dtos/fuel-type-dto";
import { summarizeFuelTypeList, type FuelTypeSortKey } from "./fuel-type-list";

interface ListFuelTypeRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: FuelTypeSortKey;
  order?: SortOrder;
  /** The instant whose business month the cards cover; now by default. */
  now?: Date;
}

/**
 * The fuel types of one company. The MASTER names the company (he used to
 * get every company's catalog mixed in one table); everyone else is pinned
 * to their own. The cards count the whole search (decision 8.8).
 */
@injectable()
class ListFuelTypeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FuelTypeRepository")
    private fuelType: IFuelTypeRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  /**
   * Whether the month's refuelings may be summed for this caller. The fuel
   * type catalog is open without Gestão de Frotas (vehicles need a fuel), but
   * refuelings are a FLEET record behind `fuel_manage`: a card must not show
   * what the Abastecimentos screen would refuse.
   */
  private async seesRefuelings(user: User, businessId: string): Promise<boolean> {
    if (decidePermission(user, "fuel_manage", "read", { allowDriver: false })) {
      return false;
    }

    // The session lookup carries the user's own company's modules; the
    // MASTER (no company) or a lookup without them asks the database.
    const snapshot = user.role === "MASTER" ? undefined : user.business?.entitlements;

    return Array.isArray(snapshot)
      ? isModuleEnabled(snapshot, "FLEET")
      : hasModule(businessId, "FLEET");
  }

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    sort,
    order,
    now = new Date(),
  }: ListFuelTypeRequest): Promise<ListFuelTypeResult> {
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
      // "This month" is the company's civil month, never the server's (UTC).
      const timeZone = (await this.seesRefuelings(findUser, resolvedBusinessId))
        ? await loadBusinessTimeZone(this.business, resolvedBusinessId)
        : null;

      const { data, total, usage, refuelings } = await this.fuelType.listFuelTypes({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        search,
        ...(timeZone && { refuelWindow: businessMonthRange(now, timeZone) }),
      });

      return {
        data,
        total,
        meta: summarizeFuelTypeList(
          usage,
          timeZone && refuelings
            ? { month: businessMonthKey(now, timeZone), rows: refuelings }
            : null,
        ),
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar os tipos de combustível! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListFuelTypeUseCase };
export type { ListFuelTypeRequest };

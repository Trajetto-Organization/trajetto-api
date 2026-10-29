import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IVehicleRepository } from "../../repositories/IVehicle-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { CursorPaginatedVehicle } from "../../dtos/vehicle-dto";
import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import type { VehiclePickerAccess } from "./vehicle-picker-access";

interface SearchVehicleWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
  search?: string;
  /** What the route guard granted: the fleet record, or only the choice. */
  access?: VehiclePickerAccess;
}

/**
 * The vehicle picker and the driver's "meus veículos".
 *
 * A driver gets the vehicles they may operate — the responsible one AND the
 * one of a released or running route (FLEET-ASSIGN-1); the substitute used to
 * find an empty list. A dispatcher who only dispatches gets the choice
 * projection (DLV-COMBO-1).
 */
@injectable()
class SearchVehicleCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    businessId,
    search,
    access = "fleet",
  }: SearchVehicleWithCursorRequest): Promise<CursorPaginatedVehicle> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      return await this.vehicle.searchVehicleWithCursor({
        limit,
        cursor,
        businessId,
        driverId: findUser.driverId ?? undefined,
        search,
        fields: access === "fleet" ? "full" : "choice",
      });
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de veículos por empresa!",
        500,
      );
    }
  }
}

export { SearchVehicleCursorUseCase };

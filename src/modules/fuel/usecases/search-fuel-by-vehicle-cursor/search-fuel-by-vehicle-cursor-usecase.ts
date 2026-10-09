import { inject, injectable } from "tsyringe";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { UploadService } from "@/shared/services/upload-service";

import { CursorPaginatedFuel } from "../../dtos/fuel-dto";
import { AppError } from "@/shared/errors/AppError";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";

interface SearchFuelByVehicleCursorRequest {
  userId: string;
  vehicleId: string;
  limit?: number;
  cursor?: string;
  /** The typed term, matched like the list's search (fuel-list.ts). */
  search?: string;
}

@injectable()
class SearchFuelByVehicleCursorUseCase {
  constructor(
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute({
    userId,
    vehicleId,
    limit = 10,
    cursor,
    search,
  }: SearchFuelByVehicleCursorRequest): Promise<CursorPaginatedFuel> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findVehicle = await this.vehicle.findVehicleById(vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    // The caller's own company only (a MASTER has none and names none here,
    // so the module gate could not vouch for the vehicle's company). The
    // controller answers this exactly like a missing vehicle.
    if (findVehicle.businessId !== findUser.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    // A driver reads the history of a vehicle they may operate — the one
    // they are responsible for or the one of their released or running
    // route (FLEET-ASSIGN-1, decision 8.2) — the same rule that lets them
    // fuel it. Comparing only the responsible driver hid the history from
    // the substitute who fuels it today.
    if (findUser.driverId) {
      const allowed = await this.vehicle.canDriverOperateVehicle({
        vehicleId,
        driverId: findUser.driverId,
        businessId: findVehicle.businessId,
      });

      if (!allowed) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    const findBusiness = await this.business.findBusinessById(
      findUser.businessId as string,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const result = await this.fuel.searchFuelByVehicleWithCursor({
        limit,
        cursor,
        vehicleId,
        businessId: findUser.businessId as string,
        search,
        // Operating the vehicle opens its history, not the colleagues'
        // refuelings and CNH numbers in it (decision 4.4): a driver reads
        // their own, as on /fuel/list-fuel.
        driverId: findUser.driverId ?? undefined,
      });

      return {
        ...result,
        // `getFileUrl` assina a URL de forma assincrona (AWS SDK v3), entao a
        // projecao precisa esperar todas as assinaturas.
        data: await Promise.all(
          result.data.map(async (fuel) => ({
            ...fuel,
            odometer_photo: fuel.odometer_photo
              ? await this.uploadService.getFileUrl(fuel.odometer_photo)
              : null,
          })),
        ),
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar os abastecimentos do veículo! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { SearchFuelByVehicleCursorUseCase };

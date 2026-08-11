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
  }: SearchFuelByVehicleCursorRequest): Promise<CursorPaginatedFuel> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findVehicle = await this.vehicle.findVehicleById(vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    // Verify vehicle belongs to user's business
    if (findVehicle.businessId !== findUser.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    if (findUser.driverId && findVehicle.driverId !== findUser.driverId) {
      throw new VehicleNotAssignedToDriverError();
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

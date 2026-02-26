import { inject, injectable } from "tsyringe";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { UploadService } from "@/shared/services/upload-service";

import { ListFuelProps } from "../../dtos/fuel-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListFuelByVehicleUseCase {
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

  async execute(
    userId: string,
    vehicleId: string,
    page: number,
    pageSize: number,
  ): Promise<ListFuelProps> {
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

    const findBusiness = await this.business.findBusinessById(
      findUser.businessId as string,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const fuels = await this.fuel.listFuelsByVehicleId({
        vehicleId,
        businessId: findUser.businessId as string,
        page,
        pageSize,
      });

      return {
        ...fuels,
        data: fuels.data.map((fuel) => ({
          ...fuel,
          odometer_photo: fuel.odometer_photo
            ? this.uploadService.getFileUrl(fuel.odometer_photo)
            : null,
        })),
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar os abastecimentos do veículo! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListFuelByVehicleUseCase };

import { inject, injectable } from "tsyringe";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { FuelNotFoundError } from "../errors/fuel-not-found-error";
import { FuelNotBelongBusinessError } from "../errors/fuel-not-belong-business-error";

import { FuelDriverCannotDeleteFuelError } from "../errors/fuel-driver-cannot-delete-fuel-error";

import { AppError } from "@/shared/errors/AppError";
import { Fuel } from "../../dtos/fuel-dto";

import { UploadService } from "@/shared/services/upload-service";

interface DeleteFuelRequest {
  fuelId: string;
  businessId: string;
}

@injectable()
class DeleteFuelUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    { fuelId, businessId }: DeleteFuelRequest,
    userId: string,
  ): Promise<Fuel> {
    // Validate user exists
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Security: Drivers cannot delete fuel records
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      throw new FuelDriverCannotDeleteFuelError();
    }

    // Validate business exists
    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Validate fuel exists and belongs to business
    const findFuel = await this.fuel.getFuelByIdAndBusinessWithRelations({
      businessId,
      fuelId,
    });

    if (!findFuel) {
      throw new FuelNotFoundError();
    }

    if (findFuel.businessId !== businessId) {
      throw new FuelNotBelongBusinessError();
    }

    try {
      // Delete odometer photo if it exists
      if (findFuel.odometer_photo) {
        await this.uploadService.deleteFile(findFuel.odometer_photo);
      }

      // Delete fuel record
      const deletedFuel = await this.fuel.deleteFuel(fuelId);

      this.notificationService.createActivityIfEnabled({
        type: "Abastecimento",
        action: "delete",
        entityId: deletedFuel.id,
        description: `Abastecimento excluído do veículo ${findFuel.vehicle.license_plate} - ${findFuel.vehicle.description}`,
        status: "Deletado",
        performedBy: userId,
        businessId: businessId,
      });

      return deletedFuel;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar o abastecimento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteFuelUseCase };

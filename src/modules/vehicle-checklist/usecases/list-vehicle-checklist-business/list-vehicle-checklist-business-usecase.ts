import { inject, injectable } from "tsyringe";

import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { UploadService } from "@/shared/services/upload-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import {
  ListVehicleChecklistProps,
  ListVehicleChecklistBusinessProps,
} from "../../dtos/vehicle-checklist-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListVehicleChecklistBusinessUseCase {
  constructor(
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    listVehicleChecklistBusinessProps: ListVehicleChecklistBusinessProps,
    userId: string,
  ): Promise<ListVehicleChecklistProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      listVehicleChecklistBusinessProps.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const checklists =
        await this.vehicleChecklist.listVehicleChecklistBusiness(
          listVehicleChecklistBusinessProps,
        );

      return {
        ...checklists,
        data: checklists.data.map((checklist) => ({
          ...checklist,
          photos: checklist.photos
            ? checklist.photos.map((photoPath: string) =>
                this.uploadService.getFileUrl(photoPath),
              )
            : [],
        })),
      };
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de checklists veiculares por empresa!",
        500,
      );
    }
  }
}

export { ListVehicleChecklistBusinessUseCase };

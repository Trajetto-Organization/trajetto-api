import { inject, injectable } from "tsyringe";

import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { UploadService } from "@/shared/services/upload-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ListVehicleChecklistProps } from "../../dtos/vehicle-checklist-dto";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListVehicleChecklistUseCase {
  constructor(
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListVehicleChecklistProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const checklists = await this.vehicleChecklist.listVehicleChecklists({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

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
        "Houve um erro ao tentar listar os checklists veiculares! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListVehicleChecklistUseCase };

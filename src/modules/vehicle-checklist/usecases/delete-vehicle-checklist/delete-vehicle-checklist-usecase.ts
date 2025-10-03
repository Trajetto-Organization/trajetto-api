import { inject, injectable } from "tsyringe";

import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleChecklistNotFoundError } from "../errors/vehicle-checklist-not-found-error";
import { VehicleChecklistNotBelongBusinessError } from "../errors/vehicle-checklist-not-belong-business-error";

import { DriverCannotDeleteChecklistError } from "../errors/driver-cannot-delete-checklist-error";

import { NotificationService } from "@/shared/services/notification-service";
import { VehicleChecklist } from "../../dtos/vehicle-checklist-dto";

import { UploadService } from "@/shared/services/upload-service";
import { AppError } from "@/shared/errors/AppError";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

interface DeleteVehicleChecklistProps {
  checklistId: string;
  businessId: string;
  userId: string;
}

@injectable()
class DeleteVehicleChecklistUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute({
    checklistId,
    businessId,
    userId,
  }: DeleteVehicleChecklistProps): Promise<VehicleChecklist> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Security: Drivers cannot delete checklist records
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      throw new DriverCannotDeleteChecklistError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findChecklist =
      await this.vehicleChecklist.findVehicleChecklistById(checklistId);

    if (!findChecklist) {
      throw new VehicleChecklistNotFoundError();
    }

    if (findChecklist.businessId !== businessId) {
      throw new VehicleChecklistNotBelongBusinessError();
    }

    try {
      // Delete photos from storage if they exist
      if (findChecklist.photos && findChecklist.photos.length > 0) {
        for (const photoPath of findChecklist.photos) {
          try {
            await this.uploadService.deleteFile(photoPath);
          } catch (error) {
            console.error(`Failed to delete photo file: ${photoPath}`, error);
            // Continue with other deletions even if one fails
          }
        }
      }

      // Get vehicle information for activity description before deletion
      const findVehicle = await this.vehicle.findVehicleById(
        findChecklist.vehicleId,
      );

      const deletedChecklist =
        await this.vehicleChecklist.deleteVehicleChecklist(checklistId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Checklist Veicular",
        action: "delete",
        entityId: checklistId,
        description: findVehicle
          ? `Checklist veicular excluído para o veículo ${findVehicle.license_plate} - ${findVehicle.description}`
          : `Checklist veicular excluído`,
        status: "Deletado",
        performedBy: userId,
        businessId,
      });

      return deletedChecklist;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar o checklist veicular! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteVehicleChecklistUseCase };

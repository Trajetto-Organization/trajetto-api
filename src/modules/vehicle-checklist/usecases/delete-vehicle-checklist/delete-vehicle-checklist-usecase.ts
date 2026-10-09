import { inject, injectable } from "tsyringe";

import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleChecklistNotFoundError } from "../errors/vehicle-checklist-not-found-error";

import { VehicleChecklistDriverCannotDeleteChecklistError } from "../errors/vehicle-checklist-driver-cannot-delete-checklist-error";

import { NotificationService } from "@/shared/services/notification-service";
import { VehicleChecklist } from "../../dtos/vehicle-checklist-dto";

import { UploadService } from "@/shared/services/upload-service";
import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

const log = logger.child({ component: "vehicle-checklist" });

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
      throw new VehicleChecklistDriverCannotDeleteChecklistError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Looked up WITH the company: another company's checklist answers like
    // one that does not exist. A separate "não pertence" 403 confirmed the
    // id existed in some other tenant (decision 8.1).
    const findChecklist =
      await this.vehicleChecklist.getVehicleChecklistByIdAndBusiness({
        checklistId,
        businessId,
      });

    if (!findChecklist) {
      throw new VehicleChecklistNotFoundError();
    }

    // Get vehicle information for activity description before deletion
    const findVehicle = await this.vehicle.findVehicleById(
      findChecklist.vehicleId,
    );

    let deletedChecklist: VehicleChecklist;

    try {
      deletedChecklist =
        await this.vehicleChecklist.deleteVehicleChecklist(checklistId);
    } catch (error) {
      log.error({ err: error, checklistId }, "vehicle checklist could not be deleted");

      throw new AppError(
        "Houve um erro ao tentar deletar o checklist veicular! Por favor, tente novamente.",
        500,
      );
    }

    // The photos go only after the row is gone. They used to be deleted
    // first: a delete that then failed left a checklist whose photos no
    // longer existed. An object left behind is only storage cost.
    const photoPaths = new Set<string>(findChecklist.photos ?? []);

    await Promise.allSettled(
      [...photoPaths].map((photoPath) =>
        this.uploadService.deleteFile(photoPath).catch((error) => {
          log.error(
            { err: error, key: photoPath, checklistId },
            "checklist photo could not be deleted",
          );
        }),
      ),
    );

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
  }
}

export { DeleteVehicleChecklistUseCase };

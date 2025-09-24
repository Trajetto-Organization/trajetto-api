import { inject, injectable } from "tsyringe";

import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleChecklistNotFoundError } from "../errors/vehicle-checklist-not-found-error";
import { VehicleChecklistNotBelongBusinessError } from "../errors/vehicle-checklist-not-belong-business-error";

import { NotificationService } from "@/shared/services/notification-service";
import { VehicleChecklist } from "../../dtos/vehicle-checklist-dto";

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
    @inject("NotificationService")
    private notificationService: NotificationService,
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

    const deletedChecklist =
      await this.vehicleChecklist.deleteVehicleChecklist(checklistId);

    // Process activity asynchronously without blocking the main flow
    this.notificationService.createActivityIfEnabled({
      type: "Checklist Veicular",
      action: "delete",
      entityId: checklistId,
      description: `Checklist veicular excluído`,
      status: "Excluído",
      performedBy: userId,
      businessId,
    });

    return deletedChecklist;
  }
}

export { DeleteVehicleChecklistUseCase };

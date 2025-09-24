import { inject, injectable } from "tsyringe";

import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import {
  ListVehicleChecklistByBusinessIdProps,
  ListVehicleChecklistFormattedProps,
} from "../../dtos/vehicle-checklist-dto";

@injectable()
class ListVehicleChecklistBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
  ) {}

  async execute({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
    vehicleId,
    driverId,
    overall_condition,
    startDate,
    endDate,
    userId,
  }: ListVehicleChecklistByBusinessIdProps & {
    userId: string;
  }): Promise<ListVehicleChecklistFormattedProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const checklists = await this.vehicleChecklist.listVehicleChecklists({
      page,
      pageSize,
      businessId,
      currentUserRole,
      search,
      vehicleId,
      driverId,
      overall_condition,
      startDate,
      endDate,
    });

    return checklists;
  }
}

export { ListVehicleChecklistBusinessUseCase };

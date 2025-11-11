import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IVehicleAssignmentRepository } from "../../repositories/IVehicleAssignment-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import {
  ListVehicleAssignmentsProps,
  ListVehicleAssignmentsResult,
} from "../../dtos/vehicle-assignment-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListAssignmentsBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleAssignmentRepository")
    private vehicleAssignment: IVehicleAssignmentRepository,
  ) {}

  async execute(
    props: ListVehicleAssignmentsProps,
    userId: string,
  ): Promise<ListVehicleAssignmentsResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(props.businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== props.businessId) {
        throw new AppError("Sem permissão para acessar esta empresa!", 403);
      }
    }

    const result = await this.vehicleAssignment.listAssignments(props);
    return result;
  }
}

export { ListAssignmentsBusinessUseCase };

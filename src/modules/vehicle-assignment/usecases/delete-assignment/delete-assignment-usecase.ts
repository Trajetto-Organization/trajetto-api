import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IVehicleAssignmentRepository } from "../../repositories/IVehicleAssignment-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleAssignmentNotFoundError } from "../errors/vehicle-assignment-not-found-error";

import { VehicleAssignment } from "../../dtos/vehicle-assignment-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class DeleteAssignmentUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleAssignmentRepository")
    private vehicleAssignment: IVehicleAssignmentRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    assignmentId: string,
    businessId: string,
    userId: string,
  ): Promise<VehicleAssignment> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== businessId) {
        throw new AppError("Sem permissão para acessar esta empresa!", 403);
      }
    }

    const existingAssignment =
      await this.vehicleAssignment.findAssignmentByBusinessAndId(
        assignmentId,
        businessId,
      );

    if (!existingAssignment) {
      throw new VehicleAssignmentNotFoundError();
    }

    try {
      const assignment =
        await this.vehicleAssignment.deleteAssignment(assignmentId);

      this.notificationService.createActivityIfEnabled({
        type: "VehicleAssignment",
        action: "delete",
        entityId: assignment.id,
        description: `Atribuição removida | ${assignment.id}`,
        status: "active",
        performedBy: userId,
        businessId,
      });

      return assignment;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar remover a atribuição! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteAssignmentUseCase };

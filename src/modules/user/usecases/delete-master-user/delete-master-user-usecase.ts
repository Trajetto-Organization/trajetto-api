import { inject, injectable } from "tsyringe";

import { NotificationService } from "@/shared/services/notification-service";
import { sendSecurityEventToUser } from "@/websocket";

import { IUserRepository } from "../../repositories/IUser-repository";

import { AppError } from "@/shared/errors/AppError";
import { User } from "../../dtos/user-dto";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserCannotBeDeletedByHimselfError } from "../errors/user-cannot-be-deleted-by-himself-error";

import { UserCannotDeleteLastMasterError } from "../errors/user-cannot-delete-last-master-error";
import { UserCannotDeleteMasterUserError } from "../errors/user-cannot-delete-master-user-error";

import { UserIsNotMasterError } from "../errors/user-is-not-master-error";

import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import { UserHasAssociatedServiceOrdersError } from "../errors/user-has-associated-service-orders-error";

import { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";
import { UserHasAssociatedAccountPayablesError } from "../errors/user-has-associated-account-payables-error";

interface DeleteMasterUserProps {
  masterUserId: string;
  performedById: string;
}

@injectable()
class DeleteMasterUserUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("AccountPayableRepository")
    private accountPayable: IAccountPayableRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    masterUserId,
    performedById,
  }: DeleteMasterUserProps): Promise<User> {
    // Validate the performing user exists and is MASTER
    const performingUser = await this.user.findUserById(performedById);

    if (!performingUser) {
      throw new ResourceNotFoundError();
    }

    if (performingUser.role !== "MASTER") {
      throw new UserCannotDeleteMasterUserError();
    }

    // Cannot delete yourself
    if (performedById === masterUserId) {
      throw new UserCannotBeDeletedByHimselfError();
    }

    // Find the master user to be deleted
    const masterUser = await this.user.findUserById(masterUserId);

    if (!masterUser) {
      throw new ResourceNotFoundError();
    }

    if (masterUser.role !== "MASTER") {
      throw new UserIsNotMasterError();
    }

    // Cannot delete the last MASTER
    const { total: masterCount } = await this.user.listMasterUsers({
      page: 1,
      pageSize: 1,
    });

    if (masterCount <= 1) {
      throw new UserCannotDeleteLastMasterError();
    }

    // Check for associated service orders
    const associatedServiceOrders =
      await this.serviceOrder.findServiceOrdersByResponsibleUserId(
        masterUserId,
      );

    if (associatedServiceOrders.length > 0) {
      throw new UserHasAssociatedServiceOrdersError(
        associatedServiceOrders.length,
      );
    }

    // Check for associated account payables
    const associatedAccountPayables =
      await this.accountPayable.findAccountPayablesByRegistrationUserId(
        masterUserId,
      );

    if (associatedAccountPayables.length > 0) {
      throw new UserHasAssociatedAccountPayablesError(
        associatedAccountPayables.length,
      );
    }

    try {
      const deletedMaster = await this.user.deleteUser(masterUserId);
      sendSecurityEventToUser(masterUserId, { reason: "access_denied" });

      // Register activity
      this.notificationService.createActivityIfEnabled({
        type: "Usuário",
        action: "delete",
        entityId: deletedMaster.id,
        description: `Usuário Master ${deletedMaster.name} | ${deletedMaster.email} removido | ID: ${deletedMaster.id}`,
        status: "Deletado",
        performedBy: performedById,
        businessId: null,
        visibilityLevel: "SYSTEM",
      });

      return deletedMaster;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar remover o usuário Master! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteMasterUserUseCase };

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
import { UserHasRecordsError } from "../errors/user-has-records-error";

import database from "@/../infra/database";
import { Prisma } from "@prisma/client";

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

    // The "last MASTER" check is not made here: counting before deleting is
    // a read-then-write two concurrent deletions both pass. It happens with
    // the rows locked, inside `deleteMasterUserKeepingOne`.

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
      // The removal and its audit entry commit together, under the same
      // MASTER row locks (OUTBOX-10).
      const deletedMaster = await database.$transaction(async (tx) => {
        const deleted = await this.user.deleteMasterUserKeepingOne(
          masterUserId,
          tx,
        );

        if (!deleted) return null;

        await this.notificationService.createActivityIfEnabled(
          {
            type: "Usuário",
            action: "delete",
            entityId: deleted.id,
            description: `Usuário Master ${deleted.name} | ${deleted.email} removido | ID: ${deleted.id}`,
            status: "Deletado",
            performedBy: performedById,
            businessId: null,
            visibilityLevel: "SYSTEM",
          },
          tx,
        );

        return deleted;
      });

      // `null`: the locked transaction found this was the last MASTER.
      if (!deletedMaster) {
        throw new UserCannotDeleteLastMasterError();
      }

      sendSecurityEventToUser(masterUserId, { reason: "access_denied" });

      return deletedMaster;
    } catch (error) {
      // The last-master refusal is thrown inside this block; it is an answer,
      // not a failure, and keeps its 409.
      if (error instanceof AppError) throw error;

      // A RESTRICT foreign key (an event, an import, a review, a message the
      // master authored) refused the delete: a conflict, not a retry.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2003"
      ) {
        throw new UserHasRecordsError();
      }

      throw new AppError(
        "Houve um erro ao tentar remover o usuário Master! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteMasterUserUseCase };

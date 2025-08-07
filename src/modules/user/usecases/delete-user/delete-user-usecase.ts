import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { User, UserRole } from "../../dtos/user-dto";

import { UserCannotBeDeletedByHimselfError } from "../errors/user-cannot-be-deleted-vy-himself-error";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { UserHasAssociatedServiceOrdersError } from "../errors/user-has-associated-service-orders-error";
import { AppError } from "@/shared/errors/AppError";

import { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";
import { UserHasAssociatedAccountPayablesError } from "../errors/user-has-associated-account-payables-error";

interface DeleteUserProps {
  userId: string;
  id: string;
}

@injectable()
class DeleteUserUseCase {
  private allowedDeletion: Record<UserRole, UserRole[]> = {
    BUSINESS_USER: ["BUSINESS_USER"],
    BUSINESS_ADMIN: ["BUSINESS_USER", "BUSINESS_ADMIN"],
    MASTER: ["BUSINESS_USER", "BUSINESS_ADMIN", "MASTER"],
  };

  private roleDisplayName: Record<UserRole, string> = {
    BUSINESS_USER: "Usuário",
    BUSINESS_ADMIN: "Administrador",
    MASTER: "Master",
  };

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

  async execute({ userId, id }: DeleteUserProps): Promise<User> {
    const findUser = await this.user.findUserById(id);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (findUser.id === userId) {
      throw new UserCannotBeDeletedByHimselfError();
    }

    const findDeletedUser = await this.user.findUserById(userId);

    if (!findDeletedUser) {
      throw new ResourceNotFoundError();
    }

    if (!this.allowedDeletion[findUser.role].includes(findDeletedUser.role)) {
      throw new AppError(
        `Usuários com o nível de acesso "${
          this.roleDisplayName[findUser.role]
        }" não podem deletar usuários com o nível de acesso ${
          this.roleDisplayName[findDeletedUser.role]
        }.`,
        403,
      );
    }

    const associatedServiceOrders =
      await this.serviceOrder.findServiceOrdersByResponsibleUserId(userId);

    if (associatedServiceOrders.length > 0) {
      throw new UserHasAssociatedServiceOrdersError(
        associatedServiceOrders.length,
      );
    }

    const associatedAccountPayables =
      await this.accountPayable.findAccountPayablesByRegistrationUserId(userId);

    if (associatedAccountPayables.length > 0) {
      throw new UserHasAssociatedAccountPayablesError(
        associatedAccountPayables.length,
      );
    }

    try {
      const userDeleted = await this.user.deleteUser(userId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Usuário",
        action: "delete",
        entityId: userDeleted.id,
        description: `Usuário ${userDeleted.name} | ${userDeleted.email} deletado | ID: ${userDeleted.id}`,
        status: "Deletado",
        performedBy: id,
        businessId: userDeleted.businessId as string,
      });

      return userDeleted;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar o usuário! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteUserUseCase };

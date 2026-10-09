import { inject, injectable } from "tsyringe";
import { IFineRepository } from "../../repositories/IFine-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { FineNotFoundError } from "../errors/fine-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { Fine } from "../../dtos/fine-dto";

@injectable()
class DeleteFineUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    fineId: string,
    userId: string,
    businessId: string,
  ): Promise<Fine> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const existingFine = await this.fine.findFineById(fineId);

    // The same 404 for "does not exist" and "not yours": a distinct 403
    // would confirm the fine exists, which is half of what someone
    // sweeping ids wants to know.
    if (!existingFine || existingFine.businessId !== businessId) {
      throw new FineNotFoundError();
    }

    try {
      // The `businessId` in the repository too, duplicating the check above:
      // the use case protects the path someone remembered, the `where` the
      // ones nobody thought of.
      const deletedFine = await this.fine.deleteFine(fineId, businessId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Multa",
        action: "delete",
        entityId: deletedFine.id,
        description: `Multa deletada | ID: ${deletedFine.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId: existingFine.businessId,
      });

      return deletedFine;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar a multa! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteFineUseCase };

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

    // O mesmo 404 para "não existe" e "não é sua": um 403 distinto
    // confirmaria que a multa existe, que é metade do que alguém
    // varrendo ids quer saber.
    if (!existingFine || existingFine.businessId !== businessId) {
      throw new FineNotFoundError();
    }

    try {
      // O `businessId` também no repositório, duplicando a checagem acima:
      // a use case protege o caminho de que alguém lembrou, e o `where`
      // protege os que ninguém pensou.
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

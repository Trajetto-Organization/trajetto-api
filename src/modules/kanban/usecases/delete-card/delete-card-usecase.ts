import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanCard } from "../../dtos/kanban-dto";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { KanbanCardNotFoundError } from "../errors/kanban-card-not-found-error";
import { KanbanCardColumnNotFoundError } from "../errors/kanban-card-column-not-found-error";

import { KanbanNotAllowedDeleteCardBusinessError } from "../errors/kanban-not-allowed-delete-card-business-error";

import { AppError } from "@/shared/errors/AppError";
import { NotificationService } from "@/shared/services/notification-service";

@injectable()
class DeleteKanbanCardUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(cardId: string, userId: string): Promise<KanbanCard> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findCard = await this.kanban.findCardById(cardId);

    if (!findCard) {
      throw new KanbanCardNotFoundError();
    }

    const findColumn = await this.kanban.findColumnById(findCard.columnId);

    if (!findColumn) {
      throw new KanbanCardColumnNotFoundError();
    }

    // Verify user permissions
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== findColumn.businessId) {
        throw new KanbanNotAllowedDeleteCardBusinessError();
      }
    }

    try {
      const deletedCard = await this.kanban.deleteCard(cardId);

      // Register activity for card deletion
      this.notificationService.createActivityIfEnabled({
        type: "Card Kanban",
        action: "delete",
        entityId: deletedCard.id,
        description: `Card "${deletedCard.title}" deletado com sucesso do kanban | ID: ${deletedCard.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId: findColumn.businessId,
      });

      return deletedCard;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar o card! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteKanbanCardUseCase };

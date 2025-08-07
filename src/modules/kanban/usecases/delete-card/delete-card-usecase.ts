import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanCard } from "../../dtos/kanban-dto";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { KanbanCardNotFoundError } from "../errors/kanban-card-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class DeleteKanbanCardUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
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
      throw new AppError("Coluna do card não encontrada.", 404);
    }

    // Verify user permissions
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== findColumn.businessId) {
        throw new AppError(
          "Você não tem permissão para deletar cards nesta empresa.",
          403,
        );
      }
    }

    try {
      const deletedCard = await this.kanban.deleteCard(cardId);
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

import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanCard, UpdateKanbanCardProps } from "../../dtos/kanban-dto";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { KanbanCardNotFoundError } from "../errors/kanban-card-not-found-error";

@injectable()
class UpdateKanbanCardUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
  ) {}

  async execute(
    cardData: UpdateKanbanCardProps,
    cardId: string,
    userId: string,
  ): Promise<KanbanCard> {
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
          "Você não tem permissão para editar cards nesta empresa.",
          403,
        );
      }
    }

    // Verify assigned user if changed
    if (
      cardData.assignedUserId !== undefined &&
      cardData.assignedUserId !== null
    ) {
      const assignedUser = await this.user.findUserById(
        cardData.assignedUserId,
      );

      if (!assignedUser) {
        throw new AppError("Usuário atribuído não encontrado.", 400);
      }

      if (
        findUser.role !== "MASTER" &&
        assignedUser.businessId !== findColumn.businessId
      ) {
        throw new AppError(
          "O usuário atribuído não pertence a esta empresa.",
          400,
        );
      }
    }

    try {
      const updatedCard = await this.kanban.updateCard({
        cardData,
        cardId,
      });

      return updatedCard;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o card! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateKanbanCardUseCase };

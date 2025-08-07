import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanCard, CreateKanbanCardProps } from "../../dtos/kanban-dto";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { KanbanColumnNotFoundError } from "../errors/kanban-column-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class CreateKanbanCardUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
  ) {}

  async execute(
    cardData: CreateKanbanCardProps,
    userId: string,
  ): Promise<KanbanCard> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findColumn = await this.kanban.findColumnById(cardData.columnId);

    if (!findColumn) {
      throw new KanbanColumnNotFoundError();
    }

    // Verify user permissions
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== findColumn.businessId) {
        throw new AppError(
          "Você não tem permissão para criar cards nesta empresa.",
          403,
        );
      }
    }

    // Verify assigned user exists and belongs to the same business
    if (cardData.assignedUserId) {
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
      const card = await this.kanban.createCard(cardData);
      return card;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o card! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateKanbanCardUseCase };

import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ReorderKanbanCardsProps } from "../../dtos/kanban-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ReorderKanbanCardsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
  ) {}

  async execute(data: ReorderKanbanCardsProps, userId: string): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Group cards by column to check permissions more efficiently
    const cardsByColumn = new Map<string, string[]>();

    // Verify all cards and check permissions
    for (const cardData of data.cards) {
      const card = await this.kanban.findCardById(cardData.id);
      if (!card) {
        throw new AppError(`Card ${cardData.id} não encontrado.`, 404);
      }

      // Store cards by column for permission check
      if (!cardsByColumn.has(cardData.columnId)) {
        cardsByColumn.set(cardData.columnId, []);
      }
      cardsByColumn.get(cardData.columnId)!.push(cardData.id);
    }

    // Check permissions for each column
    for (const [columnId, cardIds] of cardsByColumn) {
      const column = await this.kanban.findColumnById(columnId);
      if (!column) {
        throw new AppError(`Coluna ${columnId} não encontrada.`, 404);
      }

      // Verify user permissions
      if (findUser.role !== "MASTER") {
        if (findUser.businessId !== column.businessId) {
          throw new AppError(
            "Você não tem permissão para reordenar cards nesta empresa.",
            403,
          );
        }
      }
    }

    try {
      await this.kanban.reorderCards(data);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar reordenar os cards! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ReorderKanbanCardsUseCase };

import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ReorderKanbanCardsProps } from "../../dtos/kanban-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { KanbanCardNotFoundError } from "../errors/kanban-card-not-found-error";
import { KanbanColumnNotFoundError } from "../errors/kanban-column-not-found-error";
import { KanbanCardCrossBoardMoveError } from "../errors/kanban-card-cross-board-move-error";

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

    const isMaster = findUser.role === "MASTER";

    // Resolved once per column: a board reorder touches few columns and many
    // cards. `null` is a column that does not exist.
    const columnBusiness = new Map<string, string | null>();

    const businessOfColumn = async (
      columnId: string,
    ): Promise<string | null> => {
      if (columnBusiness.has(columnId)) {
        return columnBusiness.get(columnId) ?? null;
      }

      const column = await this.kanban.findColumnById(columnId);
      const businessId = column?.businessId ?? null;

      columnBusiness.set(columnId, businessId);
      return businessId;
    };

    // What the caller may see: the MASTER every board, anyone else their own.
    const visible = (businessId: string | null): businessId is string =>
      businessId !== null && (isMaster || businessId === findUser.businessId);

    // Both ends of every move. Checking only the TARGET column let an admin
    // of one company pull another company's card onto their own board. An end
    // on another company's board answers as a missing one (decision 11.3).
    for (const cardData of data.cards) {
      const card = await this.kanban.findCardById(cardData.id);
      const sourceBusinessId = card
        ? await businessOfColumn(card.columnId)
        : null;

      if (!visible(sourceBusinessId)) {
        throw new KanbanCardNotFoundError();
      }

      const targetBusinessId = await businessOfColumn(cardData.columnId);

      if (!visible(targetBusinessId)) {
        throw new KanbanColumnNotFoundError();
      }

      // Only the MASTER sees two boards; not even they move a card across.
      if (sourceBusinessId !== targetBusinessId) {
        throw new KanbanCardCrossBoardMoveError();
      }
    }

    try {
      await this.kanban.reorderCards(data);
    } catch (error) {
      // A column or card deleted meanwhile: the repository says "not found".
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar reordenar os cards! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ReorderKanbanCardsUseCase };

import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanCard, UpdateKanbanCardProps } from "../../dtos/kanban-dto";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { UserAssignedUserNotFoundError } from "@/modules/user/usecases/errors/user-assigned-user-not-found-error";
import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";

import { KanbanNotAllowedUpdateCardBusinessError } from "../errors/kanban-not-allowed-update-card-business-error";
import { KanbanCardColumnNotFoundError } from "../errors/kanban-card-column-not-found-error";

import { KanbanCardNotFoundError } from "../errors/kanban-card-not-found-error";

import { AppError } from "@/shared/errors/AppError";

import { OutboxService } from "@/shared/notifications/outbox-service";
import database from "@/../infra/database";

@injectable()
class UpdateKanbanCardUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
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
      throw new KanbanCardColumnNotFoundError();
    }

    // Verify user permissions
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== findColumn.businessId) {
        throw new KanbanNotAllowedUpdateCardBusinessError();
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
        throw new UserAssignedUserNotFoundError();
      }

      if (
        findUser.role !== "MASTER" &&
        assignedUser.businessId !== findColumn.businessId
      ) {
        throw new UserNotBelongBusinessError();
      }
    }

    try {
      // Only a hand-over pages someone: an update that keeps the assignment
      // publishes with no recipient and feeds the activity trail alone.
      const assignedUserChanged =
        cardData.assignedUserId !== undefined &&
        findCard.assignedUserId !== cardData.assignedUserId;

      const updatedCard = await database.$transaction(async (tx) => {
        const updated = await this.kanban.updateCard({ cardData, cardId }, tx);

        await this.outbox.publish(tx, {
          topic: "kanban-card.updated",
          aggregateType: "kanban-card",
          aggregateId: updated.id,
          businessId: findColumn.businessId,
          actorId: userId,
          payload: {
            cardId: updated.id,
            businessId: findColumn.businessId,
            title: updated.title,
            description: updated.description || null,
            priority: updated.priority,
            dueDate: updated.dueDate
              ? new Date(updated.dueDate).toISOString()
              : null,
            isCompleted: Boolean(updated.completed),
            assignedUserId:
              assignedUserChanged && cardData.assignedUserId
                ? cardData.assignedUserId
                : null,
          },
        });

        return updated;
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

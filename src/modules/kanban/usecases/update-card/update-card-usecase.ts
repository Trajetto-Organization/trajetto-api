import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanCard, UpdateKanbanCardProps } from "../../dtos/kanban-dto";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { UserAssignedUserNotFoundError } from "@/modules/user/usecases/errors/user-assigned-user-not-found-error";
import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";

import { KanbanCardColumnNotFoundError } from "../errors/kanban-card-column-not-found-error";

import { KanbanCardNotFoundError } from "../errors/kanban-card-not-found-error";

import { AppError } from "@/shared/errors/AppError";

import { OutboxService } from "@/shared/notifications/outbox-service";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { loadBusinessTimeZone } from "@/shared/time/business-time-zone";
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
    @inject("BusinessRepository")
    private business: IBusinessRepository,
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

    // Another company's card answers as a missing one (decision 11.3).
    if (
      findUser.role !== "MASTER" &&
      findUser.businessId !== findColumn.businessId
    ) {
      throw new KanbanCardNotFoundError();
    }

    // Verify assigned user if changed
    if (
      cardData.assignedUserId !== undefined &&
      cardData.assignedUserId !== null
    ) {
      const assignedUser = await this.user.findUserById(
        cardData.assignedUserId,
      );

      // For everyone, the MASTER included: the card stays inside its board's
      // company. Only the MASTER is told why; anyone else hears "not found".
      if (
        !assignedUser ||
        (findUser.role !== "MASTER" &&
          assignedUser.businessId !== findColumn.businessId)
      ) {
        throw new UserAssignedUserNotFoundError();
      }

      if (assignedUser.businessId !== findColumn.businessId) {
        throw new UserNotBelongBusinessError();
      }
    }

    // Read before the transaction: the message prints the due day in the
    // company's zone (decision 1.1), and the render never queries.
    const timeZone = await loadBusinessTimeZone(
      this.business,
      findColumn.businessId,
    );

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
            timeZone,
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
      // Deleted meanwhile: the repository says "not found".
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar atualizar o card! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateKanbanCardUseCase };

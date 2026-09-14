import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanCard, CreateKanbanCardProps } from "../../dtos/kanban-dto";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { KanbanNotAllowedCreateCardBusinessError } from "../errors/kanban-not-allowed-create-card-business-error";
import { UserAssignedUserNotFoundError } from "@/modules/user/usecases/errors/user-assigned-user-not-found-error";

import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";
import { KanbanColumnNotFoundError } from "../errors/kanban-column-not-found-error";

import { AppError } from "@/shared/errors/AppError";

import { OutboxService } from "@/shared/notifications/outbox-service";
import database from "@/../infra/database";

@injectable()
class CreateKanbanCardUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
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
        throw new KanbanNotAllowedCreateCardBusinessError();
      }
    }

    // Verify assigned user exists and belongs to the same business
    if (cardData.assignedUserId) {
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
      // Card and outbox event commit together; the pipeline notifies the
      // assigned user (when there is one) and records the activity.
      const card = await database.$transaction(async (tx) => {
        const created = await this.kanban.createCard(cardData, tx);

        await this.outbox.publish(tx, {
          topic: "kanban-card.created",
          aggregateType: "kanban-card",
          aggregateId: created.id,
          businessId: findColumn.businessId,
          actorId: userId,
          payload: {
            cardId: created.id,
            businessId: findColumn.businessId,
            title: created.title,
            description: created.description || null,
            priority: created.priority,
            dueDate: created.dueDate
              ? new Date(created.dueDate).toISOString()
              : null,
            isCompleted: Boolean(created.completed),
            assignedUserId: cardData.assignedUserId || null,
            fromServiceOrder: false,
          },
        });

        return created;
      });

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

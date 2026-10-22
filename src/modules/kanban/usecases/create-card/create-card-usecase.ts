import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanCard, CreateKanbanCardProps } from "../../dtos/kanban-dto";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { UserAssignedUserNotFoundError } from "@/modules/user/usecases/errors/user-assigned-user-not-found-error";

import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";
import { KanbanColumnNotFoundError } from "../errors/kanban-column-not-found-error";

import { AppError } from "@/shared/errors/AppError";

import { OutboxService } from "@/shared/notifications/outbox-service";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { loadBusinessTimeZone } from "@/shared/time/business-time-zone";
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
    @inject("BusinessRepository")
    private business: IBusinessRepository,
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

    // Another company's column answers as a missing one (decision 11.3): a
    // 403 "not yours" would confirm the id exists on some other board.
    if (
      !findColumn ||
      (findUser.role !== "MASTER" &&
        findUser.businessId !== findColumn.businessId)
    ) {
      throw new KanbanColumnNotFoundError();
    }

    // Verify assigned user exists and belongs to the same business
    if (cardData.assignedUserId) {
      const assignedUser = await this.user.findUserById(
        cardData.assignedUserId,
      );

      // For everyone, the MASTER included: a card of company A assigned to
      // a user of company B would page B about A's board. Only the MASTER,
      // who sees every company, is told why; anyone else hears "not found",
      // so the check is no probe for another company's user ids.
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
            timeZone,
            isCompleted: Boolean(created.completed),
            assignedUserId: cardData.assignedUserId || null,
            fromServiceOrder: false,
          },
        });

        return created;
      });

      return card;
    } catch (error) {
      // The column was deleted between the check and the write.
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar criar o card! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateKanbanCardUseCase };

import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { KanbanCardNotFoundError } from "../errors/kanban-card-not-found-error";

import {
  decidePermission,
  type PermissionPrincipal,
} from "@/modules/middlewares/verify-permission";

interface GetKanbanCardRequest {
  userId: string;
  cardId: string;
  /** Optional for the MASTER: when named, the card must be of that company. */
  businessId?: string;
}

/**
 * One card, read only (wave 3). The card still notifies the user it is
 * designated to, a driver included (critique item 7), with a link to a
 * board the driver no longer has in any menu (D45). The app opens this
 * card, and only it, from the notification.
 *
 * What the card holds — the model has no checklist and no attachments —
 * and the column it is in. The designated user, whoever they are, reads it;
 * a full Kanban reader (admin, MASTER, a profile with kanban_manage:read)
 * reads any card of the company. A driver is never a full reader: the
 * driver map holds no Kanban key. Anything else answers 404
 * KANBAN_CARD_NOT_FOUND, the body of a card that exists nowhere.
 */
@injectable()
class GetKanbanCardUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
  ) {}

  async execute({ userId, cardId, businessId }: GetKanbanCardRequest) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const card = await this.kanban.findCardById(cardId);

    if (!card) {
      throw new KanbanCardNotFoundError();
    }

    const column = await this.kanban.findColumnById(card.columnId);

    // A card without its column is a card being deleted with it.
    if (!column) {
      throw new KanbanCardNotFoundError();
    }

    const sameCompany =
      findUser.role === "MASTER"
        ? !businessId || businessId === column.businessId
        : findUser.businessId === column.businessId;

    if (!sameCompany) {
      throw new KanbanCardNotFoundError();
    }

    const fullReader =
      decidePermission(
        findUser as unknown as PermissionPrincipal,
        "kanban_manage",
        "read",
        { allowDriver: false },
      ) === null;

    if (!fullReader && card.assignedUserId !== findUser.id) {
      throw new KanbanCardNotFoundError();
    }

    return {
      id: card.id,
      title: card.title,
      description: card.description,
      priority: card.priority,
      dueDate: card.dueDate,
      completed: card.completed ?? false,
      position: card.position,
      columnId: card.columnId,
      column: { id: column.id, title: column.title, color: column.color },
      businessId: column.businessId,
      assignedUserId: card.assignedUserId ?? null,
      // The name only: the board's line also carries e-mail and photo, which
      // a driver opening his card has no use for.
      assignedUser: card.assignedUser
        ? { id: card.assignedUser.id, name: card.assignedUser.name }
        : null,
      created_at: card.created_at,
      updated_at: card.updated_at,
    };
  }
}

export { GetKanbanCardUseCase };

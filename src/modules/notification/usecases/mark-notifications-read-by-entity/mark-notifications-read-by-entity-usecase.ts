import { inject, injectable } from "tsyringe";

import { INotificationRepository } from "../../repositories/INotification-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { sendNotificationsReadToUser } from "@/websocket";

interface MarkNotificationsReadByEntityRequest {
  userId: string;
  type: string;
  entityId: string;
}

/**
 * Marks as read the caller's unread notices about one item (wave 3).
 *
 * The push and the inbox row are separate deliveries of one event, so the
 * app that opens an order from its push never learns the row's id: it names
 * the item instead (`type` + `entityId`), and every unread row of the caller
 * about it turns read. Scoped to the session's user, never to a user or a
 * company in the request; a second call finds nothing left and changes
 * nothing.
 */
@injectable()
class MarkNotificationsReadByEntityUseCase {
  constructor(
    @inject("NotificationRepository")
    private notificationRepository: INotificationRepository,
    @inject("UserRepository")
    private userRepository: IUserRepository,
  ) {}

  /** Returns how many notifications were actually flipped. */
  async execute({
    userId,
    type,
    entityId,
  }: MarkNotificationsReadByEntityRequest): Promise<number> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    const flipped = await this.notificationRepository.markReadByEntity({
      userId,
      type,
      entityId,
    });

    // One event per row, never the `null` of "all read": the clients take
    // null as read-all and would clear the rest of the inbox and the tray.
    for (const notificationId of flipped) {
      sendNotificationsReadToUser(userId, { notificationId });
    }

    return flipped.length;
  }
}

export { MarkNotificationsReadByEntityUseCase };

import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IChatRepository } from "../../repositories/IChat-repository";

import { sendChatReadEvent } from "@/websocket";

import { resolveChatScope } from "../shared/chat-scope";
import { canWriteInChat } from "../shared/chat-access-rules";

import { ChatThreadNotFoundError } from "../errors/chat-errors";

interface MarkChatReadRequest {
  userId: string;
  threadId: string;
  businessId?: string;

  /**
   * How far the reader actually got — the created_at of the newest message
   * on their screen.
   *
   * Optional, and "now" without it. It exists because a cursor stamped with
   * the server's clock covers the WHOLE thread up to this instant, including
   * messages the reader never received: a panel parked on a search hit from
   * March discards live arrivals, and marking read from there would tell the
   * driver his message was seen when nobody saw it.
   */
  readAt?: Date;
}

@injectable()
class MarkChatReadUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ChatRepository")
    private chat: IChatRepository,
  ) {}

  async execute({
    userId,
    threadId,
    businessId: requestedBusinessId,
    readAt,
  }: MarkChatReadRequest): Promise<{ last_read_at: Date }> {
    const scope = await resolveChatScope(
      this.user,
      userId,
      requestedBusinessId,
    );

    const thread = await this.chat.findThreadById(threadId);

    // Foreign threads answer "not found", never "not yours".
    if (
      !thread ||
      thread.businessId !== scope.businessId ||
      (scope.driverId && thread.driverId !== scope.driverId)
    ) {
      throw new ChatThreadNotFoundError();
    }

    const now = new Date();

    // Clamped to now, like the delivery receipt: the timestamp rides a client
    // clock, and one running ahead would mark as read messages that do not
    // exist yet. The repository keeps it advance-only from there.
    const lastReadAt = readAt && readAt < now ? readAt : now;

    // A MASTER watching for support must not move the company's cursor. The
    // driver's double check is derived from the most advanced cursor on the
    // company side, so a master's read would show "the base read it" when
    // nobody at the base did — a lie told to the driver. Nothing is written
    // and no chatRead is emitted; the answer stays successful because the
    // interface marks a thread read the moment it is opened, and an error
    // there would be a toast with no cause.
    if (!canWriteInChat(scope.user.role)) {
      return { last_read_at: lastReadAt };
    }

    await this.chat.markThreadRead(thread.id, userId, lastReadAt);

    // The other side's single checks turn double, live.
    const driverUser = await this.user.findUserByDriverId(thread.driverId);

    sendChatReadEvent(scope.businessId, driverUser?.id ?? null, {
      threadId: thread.id,
      userId,
      last_read_at: lastReadAt.toISOString(),
    });

    return { last_read_at: lastReadAt };
  }
}

export { MarkChatReadUseCase };

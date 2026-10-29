import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IChatRepository } from "../../repositories/IChat-repository";
import { ChatDeliverySide } from "../../dtos/chat-dto";

import { sendChatDeliveredEvent } from "@/websocket";

import { resolveChatScope } from "../shared/chat-scope";
import { canWriteInChat } from "../shared/chat-access-rules";

import {
  ChatDeliveryReceiptNotAllowedError,
  ChatThreadNotFoundError,
} from "../errors/chat-errors";

interface MarkChatDeliveredRequest {
  userId: string;
  threadId: string;

  /** The created_at of the newest message the device already holds. */
  deliveredAt?: Date;

  /** A MASTER's chosen company, when the caller is on the SAC side. */
  businessId?: string;
}

@injectable()
class MarkChatDeliveredUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ChatRepository")
    private chat: IChatRepository,
  ) {}

  async execute({
    userId,
    threadId,
    deliveredAt,
    businessId: requestedBusinessId,
  }: MarkChatDeliveredRequest): Promise<{
    delivered_at: Date;
    side: ChatDeliverySide;
  }> {
    const scope = await resolveChatScope(
      this.user,
      userId,
      requestedBusinessId,
    );

    const side: ChatDeliverySide = scope.driverId ? "DRIVER" : "STAFF";

    // A MASTER is the software vendor watching for support, not the
    // customer's operation. Their panel holding the message must never tell
    // the driver "the base has it" — the same reason they cannot write or
    // advance the read cursor.
    if (side === "STAFF" && !canWriteInChat(scope.user.role)) {
      throw new ChatDeliveryReceiptNotAllowedError();
    }

    const thread = await this.chat.findThreadById(threadId);

    // Foreign threads answer "not found", never "not yours". A driver is
    // additionally locked to their own thread.
    if (
      !thread ||
      thread.businessId !== scope.businessId ||
      (scope.driverId && thread.driverId !== scope.driverId)
    ) {
      throw new ChatThreadNotFoundError();
    }

    // The client sends the created_at of the newest message it holds, so a
    // receipt that took a whole tunnel to arrive still marks exactly what
    // was on the device. The server clamps it to now because the timestamp
    // rides a client clock: one running ahead would mark as delivered
    // messages that do not exist yet, and the cursor never rewinds.
    const now = new Date();
    const at = deliveredAt && deliveredAt < now ? deliveredAt : now;

    await this.chat.markThreadDelivered(thread.id, at, side);

    // The receipt is news for the OTHER counter only: a confirmation is
    // worthless to the device that just issued it. The driver's user is
    // resolved only for a staff receipt, which is the direction that has to
    // reach one specific phone.
    const driverUser =
      side === "STAFF"
        ? await this.user.findUserByDriverId(thread.driverId)
        : null;

    sendChatDeliveredEvent(scope.businessId, {
      threadId: thread.id,
      side,
      driverUserId: side === "STAFF" ? (driverUser?.id ?? null) : userId,
      delivered_at: at.toISOString(),
    });

    return { delivered_at: at, side };
  }
}

export { MarkChatDeliveredUseCase };

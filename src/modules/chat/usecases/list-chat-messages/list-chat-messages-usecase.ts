import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IChatRepository } from "../../repositories/IChat-repository";

import { UploadService } from "@/shared/services/upload-service";

import { resolveChatScope } from "../shared/chat-scope";
import {
  PresentedChatMessage,
  presentChatMessage,
} from "../shared/chat-presenter";

import {
  ChatMessageNotFoundError,
  ChatThreadNotFoundError,
} from "../errors/chat-errors";

interface ListChatMessagesRequest {
  userId: string;
  threadId?: string;

  /** Staff alternative to threadId: which driver's conversation to open. */
  driverId?: string;

  /** Walks towards the present instead of into the past. */
  after?: { created_at: Date; id: string };

  /**
   * Centre the page on this message — "jump to this message" from a search
   * hit. Takes precedence over both cursors.
   */
  aroundMessageId?: string;
  before?: { created_at: Date; id: string };
  limit: number;
  search?: string;
  businessId?: string;
}

interface ListChatMessagesResponse {
  /** Null when the driver has no conversation yet — an empty, valid chat. */
  threadId: string | null;
  data: PresentedChatMessage[];
  nextCursor: { created_at: string; id: string } | null;

  /** The cursor towards the present, and whether anything is out there. */
  previousCursor: { created_at: string; id: string } | null;
  hasNewer: boolean;

  counterpartLastReadAt: Date | null;

  /**
   * The driver's app account, or null when he has none.
   *
   * It rides here so the conversation view can stand on its own. The panel
   * used to infer this from the thread list, which is paginated AND filtered
   * by the search box — so opening a driver from a message-text hit showed
   * "no app access" and "say hello, this conversation starts now" over a
   * history that existed all along.
   */
  driverUser: { id: string; last_seen_at: Date | null } | null;

  /** Grey double check — only a staff viewer ever gets a value here. */
  counterpartDeliveredAt: Date | null;
}

@injectable()
class ListChatMessagesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ChatRepository")
    private chat: IChatRepository,
    @inject("UploadService")
    private uploadService: UploadService,
    @inject("DriverRepository")
    private driver: IDriverRepository,
  ) {}

  async execute({
    userId,
    threadId,
    driverId,
    before,
    after,
    aroundMessageId,
    limit,
    search,
    businessId: requestedBusinessId,
  }: ListChatMessagesRequest): Promise<ListChatMessagesResponse> {
    const scope = await resolveChatScope(
      this.user,
      userId,
      requestedBusinessId,
    );

    // Whose conversation this is. A driver token can only ever be its own,
    // whatever the query asks for; the staff picks, by thread or by driver.
    const targetDriverId = scope.driverId ?? driverId ?? null;

    // A driver resolves their own thread from the token; a foreign threadId
    // answers "not found", never "not yours" — same non-leak rule as
    // list-delivery.
    const thread = threadId
      ? await this.chat.findThreadById(threadId)
      : targetDriverId
        ? await this.chat.findThreadByDriver(scope.businessId, targetDriverId)
        : null;

    if (scope.driverId && threadId && thread && thread.driverId !== scope.driverId) {
      throw new ChatThreadNotFoundError();
    }

    // Asked by driver and there is no conversation yet: that is not an error,
    // it is an empty chat. The staff side gets the same answer the driver
    // side has always had — a panel opening a driver who was never written to
    // must render a blank thread, not a failure.
    if (!thread && targetDriverId) {
      return {
        threadId: null,
        data: [],
        nextCursor: null,
        previousCursor: null,
        hasNewer: false,
        counterpartLastReadAt: null,
        counterpartDeliveredAt: null,
        driverUser: await this.resolveDriverUser(scope.businessId, targetDriverId),
      };
    }

    if (!thread || thread.businessId !== scope.businessId) {
      throw new ChatThreadNotFoundError();
    }

    // The anchor is resolved HERE, not on the client: only the server knows
    // the message's (created_at, id) pair, and only it can check the message
    // really lives in this thread before centring a page on it.
    const anchor = aroundMessageId
      ? await this.chat.findMessageById(aroundMessageId)
      : null;

    if (aroundMessageId && (!anchor || anchor.threadId !== thread.id)) {
      throw new ChatMessageNotFoundError();
    }

    const result = await this.chat.listMessages({
      threadId: thread.id,
      viewerIsDriverSide: Boolean(scope.driverId),
      before,
      after,
      around: anchor
        ? { created_at: anchor.created_at, id: anchor.id }
        : undefined,
      limit,
      search,
    });

    const data = await Promise.all(
      result.data.map((message) =>
        presentChatMessage(message, this.uploadService),
      ),
    );

    return {
      threadId: thread.id,
      data,
      driverUser: await this.resolveDriverUser(scope.businessId, thread.driverId),
      nextCursor: result.nextCursor,
      previousCursor: result.previousCursor,
      hasNewer: result.hasNewer,
      counterpartLastReadAt: result.counterpartLastReadAt,
      counterpartDeliveredAt: result.counterpartDeliveredAt,
    };
  }

  /**
   * The driver's app account, scoped to the caller's company.
   *
   * The tenant check is the point: a driverId arrives from the query string,
   * so answering for a driver of another company would leak whether that
   * driver exists and whether he has an account. Out of scope reads exactly
   * like a driver with no app access.
   */
  private async resolveDriverUser(
    businessId: string,
    driverId: string,
  ): Promise<{ id: string; last_seen_at: Date | null } | null> {
    const driver = await this.driver.findDriverById(driverId);

    if (!driver || driver.businessId !== businessId) return null;

    const user = await this.user.findUserByDriverId(driverId);

    if (!user) return null;

    return { id: user.id, last_seen_at: user.last_seen_at ?? null };
  }
}

export { ListChatMessagesUseCase };

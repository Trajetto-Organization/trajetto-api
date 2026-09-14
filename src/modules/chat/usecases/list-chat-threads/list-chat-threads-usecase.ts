import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IChatRepository } from "../../repositories/IChat-repository";

import { ListChatThreadsResult } from "../../dtos/chat-dto";
import { resolveChatScope } from "../shared/chat-scope";

interface ListChatThreadsRequest {
  userId: string;
  page: number;
  pageSize: number;
  search?: string;
  businessId?: string;
}

/**
 * The SAC's inbox — every driver conversation, freshest first, with unread
 * badges. A driver token gets the same shape scoped to their own thread,
 * which is how the app's hub badge is fed.
 */
@injectable()
class ListChatThreadsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ChatRepository")
    private chat: IChatRepository,
  ) {}

  async execute({
    userId,
    page,
    pageSize,
    search,
    businessId: requestedBusinessId,
  }: ListChatThreadsRequest): Promise<
    ListChatThreadsResult & { businessId: string }
  > {
    const scope = await resolveChatScope(
      this.user,
      userId,
      requestedBusinessId,
    );

    const result = await this.chat.listThreads({
      businessId: scope.businessId,
      requesterUserId: userId,
      driverId: scope.driverId ?? undefined,
      search,
      page,
      pageSize,
    });

    // The controller needs the resolved scope to enrich presence.
    return { ...result, businessId: scope.businessId };
  }
}

export { ListChatThreadsUseCase };

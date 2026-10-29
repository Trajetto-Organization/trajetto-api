import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IChatRepository } from "../../repositories/IChat-repository";

import { UploadService } from "@/shared/services/upload-service";

import { resolveChatScope } from "../shared/chat-scope";
import {
  PresentedChatMessage,
  presentChatMessage,
} from "../shared/chat-presenter";

interface SearchChatMessagesRequest {
  userId: string;
  search: string;
  limit: number;
  businessId?: string;
}

interface ChatMessageSearchResult extends PresentedChatMessage {
  driver: { id: string; name: string };
}

/**
 * "Where did he say the client would receive after 14h?" — text search over
 * the history: the SAC searches every conversation, a driver only their own.
 */
@injectable()
class SearchChatMessagesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ChatRepository")
    private chat: IChatRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute({
    userId,
    search,
    limit,
    businessId: requestedBusinessId,
  }: SearchChatMessagesRequest): Promise<{ data: ChatMessageSearchResult[] }> {
    const scope = await resolveChatScope(
      this.user,
      userId,
      requestedBusinessId,
    );

    const hits = await this.chat.searchMessages({
      businessId: scope.businessId,
      search,
      limit,
      driverId: scope.driverId ?? undefined,
    });

    const data = await Promise.all(
      hits.map(async (hit) => ({
        ...(await presentChatMessage(hit, this.uploadService)),
        driver: hit.driver,
      })),
    );

    return { data };
  }
}

export { SearchChatMessagesUseCase };

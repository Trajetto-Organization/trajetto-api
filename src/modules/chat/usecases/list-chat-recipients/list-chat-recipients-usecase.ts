import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IChatRepository } from "../../repositories/IChat-repository";

import {
  ChatAudienceCount,
  ChatRecipientAppFilter,
  ListChatRecipientsResult,
} from "../../dtos/chat-dto";

import { resolveChatScope } from "../shared/chat-scope";
import { permissionDenied } from "@/shared/errors/access-errors";

interface ListChatRecipientsRequest {
  userId: string;
  businessId?: string;
  search?: string;
  app?: ChatRecipientAppFilter;
  cursor?: string;
  limit: number;
}

interface ListChatRecipientsResponse extends ListChatRecipientsResult {
  /**
   * Company-wide, not search-filtered: what "todos os motoristas ativos com
   * o app" would reach. Only on the first page — later pages keep the count
   * the first one gave, and counting again on every scroll buys nothing.
   */
  audience: ChatAudienceCount | null;
}

/**
 * Who the SAC can write to, for "Nova conversa" and the mass notice.
 *
 * Under `delivery_manage:read` (the chat's own permission) rather than the
 * driver search's `driver_manage:read`: a tower user allowed to send used to
 * open both pickers on an empty list. It answers the three fields a choice
 * needs (id, name, hasApp) and nothing of the driver's registration — the
 * CNH included (decision 4.7).
 */
@injectable()
class ListChatRecipientsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ChatRepository")
    private chat: IChatRepository,
  ) {}

  async execute({
    userId,
    businessId: requestedBusinessId,
    search,
    app,
    cursor,
    limit,
  }: ListChatRecipientsRequest): Promise<ListChatRecipientsResponse> {
    const scope = await resolveChatScope(
      this.user,
      userId,
      requestedBusinessId,
    );

    // The driver table opens delivery_manage to the app, and a driver has
    // one conversation, with the company — never a list of his colleagues
    // (decision 4.4).
    if (scope.driverId) {
      throw permissionDenied("Motoristas não escolhem destinatários no chat.");
    }

    const page = await this.chat.listRecipients({
      businessId: scope.businessId,
      search,
      app,
      cursor,
      limit,
    });

    const audience = cursor
      ? null
      : await this.chat.countAudience(scope.businessId);

    return { ...page, audience };
  }
}

export { ListChatRecipientsUseCase };
export type { ListChatRecipientsResponse };

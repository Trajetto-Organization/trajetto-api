import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IChatRepository } from "../../repositories/IChat-repository";

import { UploadService } from "@/shared/services/upload-service";

import { resolveChatScope } from "../shared/chat-scope";

import { ChatMessageNotFoundError } from "../errors/chat-errors";

interface GetChatAttachmentUrlRequest {
  userId: string;
  messageId: string;
  businessId?: string;
}

/**
 * A fresh signed url for ONE attachment.
 *
 * Attachment urls are minted per request and expire, so a viewer left open
 * eventually shows a broken photo. Until this existed, the only cure a client
 * had was reloading the whole conversation — which on the phone meant the
 * message list being replaced by the newest page, the photo the driver was
 * looking at dropping out of it, and the viewer closing on top of him. The
 * cure was worse than the failure.
 *
 * Re-signing one message is what a retry actually needs: no pagination is
 * disturbed, nothing is dropped, and the answer is a single indexed lookup.
 */
@injectable()
class GetChatAttachmentUrlUseCase {
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
    messageId,
    businessId: requestedBusinessId,
  }: GetChatAttachmentUrlRequest): Promise<{ attachment_url: string | null }> {
    const scope = await resolveChatScope(
      this.user,
      userId,
      requestedBusinessId,
    );

    const message = await this.chat.findMessageById(messageId);

    if (!message) {
      throw new ChatMessageNotFoundError();
    }

    const thread = await this.chat.findThreadById(message.threadId);

    // Same non-leak rule as everywhere else in the module: a message of
    // another company, or of another driver's thread, answers exactly like a
    // message that does not exist. It used to answer "conversa não
    // encontrada" instead, which told a caller the id was real elsewhere.
    if (
      !thread ||
      thread.businessId !== scope.businessId ||
      (scope.driverId && thread.driverId !== scope.driverId)
    ) {
      throw new ChatMessageNotFoundError();
    }

    // A text message has nothing to sign. Null rather than an error: asking
    // is legitimate, the answer is simply that there is no file.
    if (!message.attachment_key) {
      return { attachment_url: null };
    }

    return {
      attachment_url: await this.uploadService.getFileUrl(
        message.attachment_key,
      ),
    };
  }
}

export { GetChatAttachmentUrlUseCase };

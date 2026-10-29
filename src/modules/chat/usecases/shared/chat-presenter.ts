import { UploadService } from "@/shared/services/upload-service";
import { ChatMessageView } from "../../dtos/chat-dto";

/**
 * The wire shape of a message: the storage key never leaves the API — what
 * goes out is a signed URL minted at read time, like every photo in the
 * product.
 */
interface PresentedChatMessage extends Omit<ChatMessageView, "attachment_key"> {
  attachment_url: string | null;
}

async function presentChatMessage(
  view: ChatMessageView,
  uploadService: UploadService,
): Promise<PresentedChatMessage> {
  const { attachment_key, ...rest } = view;

  return {
    ...rest,
    attachment_url: attachment_key
      ? await uploadService.getFileUrl(attachment_key)
      : null,
  };
}

/** The tray/preview line for a message, shared by policy payloads and lists. */
function buildChatBodyPreview(body: string | null): string | null {
  if (!body) return null;

  const trimmed = body.trim();

  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

export { presentChatMessage, buildChatBodyPreview };
export type { PresentedChatMessage };

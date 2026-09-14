import { NotificationCategory } from "@prisma/client";

import {
  ChatMessageSentPayload,
  NotificationPolicyEntry,
  RenderedPush,
} from "../notification-types";

/**
 * A SAC message headed for the driver. Push-only by design: the chat screen
 * is its own in-app surface, so a notification row per message would bury
 * the feed's real content — but the phone's tray must ring even with the
 * app closed, because this is the dispatcher trying to reach the road.
 *
 * Mandatory: a driver muting task notifications must still be reachable by
 * the operation — preferences control noise, not the company's voice.
 *
 * No renderActivity either: a conversation is not the audit trail's
 * business; the messages themselves are the record.
 */

function renderChatMessagePush(payload: ChatMessageSentPayload): RenderedPush {
  const attachmentLine =
    payload.kind === "AUDIO" ? "🎤 Mensagem de voz" : "📷 Foto";

  return {
    title: `💬 ${payload.senderName}`,
    body: payload.bodyPreview || attachmentLine,

    // Tapping the tray entry opens the conversation, not the feed.
    data: { url: "/chat" },
  };
}

const chatMessageSentPolicy: NotificationPolicyEntry<ChatMessageSentPayload> = {
  category: NotificationCategory.TASKS,
  mandatory: true,

  async resolveRecipients(payload, deps) {
    const recipient = await deps.userRepository.findUserById(
      payload.recipientUserId,
    );

    return recipient ? [recipient] : [];
  },

  renderPush: renderChatMessagePush,
};

export { chatMessageSentPolicy, renderChatMessagePush };

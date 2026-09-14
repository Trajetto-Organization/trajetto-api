import { z } from "zod";

import { listChatThreadsSchema } from "@/schemas/list-chat-threads-schema";
import { listChatMessagesSchema } from "@/schemas/list-chat-messages-schema";

import { searchChatMessagesSchema } from "@/schemas/search-chat-messages-schema";
import { sendChatMessageSchema } from "@/schemas/send-chat-message-schema";
import { markChatReadSchema } from "@/schemas/mark-chat-read-schema";
import { markChatDeliveredSchema } from "@/schemas/mark-chat-delivered-schema";
import { getChatAttachmentUrlSchema } from "@/schemas/get-chat-attachment-url-schema";

// The cursor pair is minted here as ISO strings, so it can be strict.
const chatCursorEntity = z
  .object({ created_at: z.string(), id: z.string() })
  .nullable();

const chatSchemas = {
  listThreads: listChatThreadsSchema,
  listMessages: listChatMessagesSchema,
  searchMessages: searchChatMessagesSchema,
  sendMessage: sendChatMessageSchema,
  markRead: markChatReadSchema,
  attachmentUrl: getChatAttachmentUrlSchema,
  markDelivered: markChatDeliveredSchema,
};

// Rows carry nested sender/delivery/driver objects and Prisma Date fields —
// validated by zod at write time, passed through on read (the same rule as
// deliveryDetail: a strict response schema would refuse the Dates that
// JSON.stringify serializes into the ISO strings the clients expect).
const chatResponses = {
  threadList: z.object({
    data: z.array(z.unknown()),
    total: z.number(),
    totalUnread: z.number(),
  }),
  messageList: z.object({
    threadId: z.string().nullable(),
    data: z.array(z.unknown()),
    nextCursor: chatCursorEntity,

    // Only a window centred on an old message has anything newer; paging
    // back from the end never does.
    previousCursor: chatCursorEntity,
    hasNewer: z.boolean(),

    counterpartLastReadAt: z.unknown(),
    counterpartDeliveredAt: z.unknown(),

    // Null means the driver genuinely has no app account — the one fact the
    // panel used to guess from a thread list that may not have loaded him.
    driverUser: z.unknown(),
  }),
  messageSent: z.object({
    message: z.string().default("Mensagem enviada!"),
    data: z.array(z.unknown()),
  }),
  markRead: z.object({
    message: z.string().default("Conversa marcada como lida."),
    data: z.object({ last_read_at: z.unknown() }),
  }),
  markDelivered: z.object({
    message: z.string().default("Entrega confirmada."),
    data: z.object({ delivered_at: z.unknown(), side: z.unknown() }),
  }),
  searchResult: z.object({
    data: z.array(z.unknown()),
  }),
  attachmentUrl: z.object({ attachment_url: z.unknown() }),
  genericError: z.object({ message: z.string() }),
  internalServerError: z.object({
    message: z
      .string()
      .default("Houve um erro interno! Por favor, tente novamente."),
  }),
};

export { chatSchemas, chatResponses };

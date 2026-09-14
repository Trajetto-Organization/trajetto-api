import { FastifyInstance } from "fastify";

import { ListChatThreadsController } from "@/modules/chat/usecases/list-chat-threads/list-chat-threads-controller";
import { ListChatMessagesController } from "@/modules/chat/usecases/list-chat-messages/list-chat-messages-controller";

import { SearchChatMessagesController } from "@/modules/chat/usecases/search-chat-messages/search-chat-messages-controller";
import { SendChatMessageController } from "@/modules/chat/usecases/send-chat-message/send-chat-message-controller";
import { MarkChatReadController } from "@/modules/chat/usecases/mark-chat-read/mark-chat-read-controller";
import { MarkChatDeliveredController } from "@/modules/chat/usecases/mark-chat-delivered/mark-chat-delivered-controller";
import { GetChatAttachmentUrlController } from "@/modules/chat/usecases/get-chat-attachment-url/get-chat-attachment-url-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import { chatSchemas, chatResponses } from "./documentation/chat-documentation";

const listChatThreadsController = new ListChatThreadsController();
const listChatMessagesController = new ListChatMessagesController();

const searchChatMessagesController = new SearchChatMessagesController();
const sendChatMessageController = new SendChatMessageController();
const markChatReadController = new MarkChatReadController();
const markChatDeliveredController = new MarkChatDeliveredController();
const getChatAttachmentUrlController = new GetChatAttachmentUrlController();

// The chat is the Deliveries module's voice channel: it exists only where
// the module is hired, and delivery_manage is its permission — read to see
// the conversations, write to speak. The driver's fixed permission table
// already grants both, so the driver app needs no profile change.
//
// A MASTER is the exception on top of that: they read every company they
// select, and write in none — the conversation belongs to the customer's
// operation, not to the software vendor.
//
// Real time rides the socket, not these routes. Clients emit
// `chatSubscribe` { businessId } when the chat screen mounts and
// `chatUnsubscribe` { businessId } when it unmounts; the server answers with
// `chatMessage`, `chatRead`, `chatDelivered`, `chatTyping`, `chatRecording`
// and `chatPresence`.
const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function chatRoutes(app: FastifyInstance) {
  app.get(
    "/list-threads",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Conversation list with unread badges",
        description:
          "One thread per driver, freshest first, with last-message preview, per-thread unread count (always derived from the reader's cursor, never accumulated), presence (online / last seen) and the cross-thread total for the tab badge. Driver tokens receive only their own thread.",
        querystring: chatSchemas.listThreads,
        response: {
          200: chatResponses.threadList,
          400: chatResponses.genericError,
          403: chatResponses.genericError,
          500: chatResponses.internalServerError,
        },
      },
    },
    listChatThreadsController.handle,
  );

  app.get(
    "/list-messages",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Conversation history (cursor-paginated)",
        description:
          "Messages newest-first with sender, optional delivery context chip and signed attachment URL. Cursor pair (beforeAt + beforeId) pages into the past. counterpartLastReadAt is how far the OTHER side has read — the double-check line. Drivers may omit threadId: their own thread is resolved from the token; a null threadId in the answer means the conversation simply has not started.",
        querystring: chatSchemas.listMessages,
        response: {
          200: chatResponses.messageList,
          400: chatResponses.genericError,
          403: chatResponses.genericError,
          500: chatResponses.internalServerError,
        },
      },
    },
    listChatMessagesController.handle,
  );

  app.get(
    "/search-messages",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Text search over the chat history",
        description:
          "Cross-thread for the SAC, own-thread for a driver token. Each hit carries the driver of its conversation so the UI can jump straight into the thread.",
        querystring: chatSchemas.searchMessages,
        response: {
          200: chatResponses.searchResult,
          400: chatResponses.genericError,
          403: chatResponses.genericError,
          500: chatResponses.internalServerError,
        },
      },
    },
    searchChatMessagesController.handle,
  );

  app.post(
    "/send-message",
    {
      // Above any real conversation pace, below a runaway loop.
      config: { rateLimit: { max: 40, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Send a message (text, photo or voice note)",
        description:
          "Creates the thread on first contact. Several driverIds fan the same text out as one independent message per thread (a mass notice, shared broadcast id). Attachments ride the presigned-PUT flow (chatAttachments) and are validated for ownership before the key becomes a row. clientSubmissionId makes a retry return the already-created message instead of a duplicate. A SAC message also pushes to the driver's phone through the notification pipeline; a driver message never rings anyone — the Chat tab badge and the socket are the SAC's signal. Messages are immutable operational records: there is no edit or delete. A MASTER token is refused with 403 MASTER_CHAT_READ_ONLY: the driver app labels every non-driver message as the company's own counter, so the master seat reads and never writes.",
        body: chatSchemas.sendMessage,
        response: {
          201: chatResponses.messageSent,
          400: chatResponses.genericError,
          403: chatResponses.genericError,
          500: chatResponses.internalServerError,
        },
      },
    },
    sendChatMessageController.handle,
  );

  app.get(
    "/attachment-url",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Re-sign one attachment",
        description:
          "A fresh signed url for a single message's attachment. Attachment urls are minted per request and expire, so a viewer left open shows a broken photo; before this the only cure a client had was reloading the whole conversation, which on the phone replaced the message list with the newest page and closed the viewer on top of the photo being looked at. Answers null for a message with no file. Out of scope reads as not found, never as 'not yours'.",
        querystring: chatSchemas.attachmentUrl,
        response: {
          200: chatResponses.attachmentUrl,
          400: chatResponses.genericError,
          403: chatResponses.genericError,
          500: chatResponses.internalServerError,
        },
      },
    },
    getChatAttachmentUrlController.handle,
  );

  app.post(
    "/mark-read",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Advance the reader's cursor",
        description:
          "Each participant keeps one cursor per thread; unread counts and read checks are derived from it. Advance-only: an out-of-order call can never rewind what was already read. `readAt` says how far the reader actually got — without it the cursor is stamped with the server clock, which covers the whole thread up to now, including messages the reader never received (a panel parked on an old search hit). Clamped to now. Emits chatRead so the other side's checks turn double live. A MASTER token gets a successful no-op — no cursor is stored and no chatRead is emitted, because the driver's double check means the company read the message, and the master is not the company.",
        body: chatSchemas.markRead,
        response: {
          200: chatResponses.markRead,
          400: chatResponses.genericError,
          403: chatResponses.genericError,
          500: chatResponses.internalServerError,
        },
      },
    },
    markChatReadController.handle,
  );

  app.post(
    "/mark-delivered",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Confirm the driver's device holds the messages",
        description:
          "Either side posts the created_at of the newest message its device already stored; the OTHER side's checks turn grey-double up to that point. The side is inferred from the token: a driver token advances the driver cursor, a SAC token the staff one (the staff cursor is the team's, the most advanced confirmation from any open panel). Advance-only, like the read cursor, and clamped to the server clock — a client running ahead cannot mark as delivered a message that does not exist yet. A MASTER is refused with 403 CHAT_DELIVERY_RECEIPT_NOT_ALLOWED: the vendor holding a message is not the customer's operation holding it. Emits chatDelivered to the opposite counter only.",
        body: chatSchemas.markDelivered,
        response: {
          200: chatResponses.markDelivered,
          400: chatResponses.genericError,
          403: chatResponses.genericError,
          500: chatResponses.internalServerError,
        },
      },
    },
    markChatDeliveredController.handle,
  );
}

export { chatRoutes };

import { z } from "zod";

import { listChatThreadsSchema } from "@/schemas/list-chat-threads-schema";
import { listChatMessagesSchema } from "@/schemas/list-chat-messages-schema";

import { searchChatMessagesSchema } from "@/schemas/search-chat-messages-schema";
import { sendChatMessageSchema } from "@/schemas/send-chat-message-schema";
import { markChatReadSchema } from "@/schemas/mark-chat-read-schema";
import { markChatDeliveredSchema } from "@/schemas/mark-chat-delivered-schema";
import { getChatAttachmentUrlSchema } from "@/schemas/get-chat-attachment-url-schema";
import { listChatRecipientsSchema } from "@/schemas/list-chat-recipients-schema";

import { documentedAs } from "./doc-only-responses";
import { driverTicketViewShape, ticketSummary } from "./support-ticket-shapes";
import { errorResponse, internalErrorResponse } from "./common-responses";

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
  listRecipients: listChatRecipientsSchema,
};

const isoDateTime = z.union([z.string(), z.date()]);

/**
 * The chat's wire shapes, for the document.
 *
 * The runtime schemas below pass the rows through (`z.unknown()`): the app
 * builds in the stores are older than this code, and a strict schema would
 * silently strip any field one of them reads and this file forgot. So the
 * typed shapes are attached with `documentedAs` — shown in /docs, never
 * applied — and tests/unitaires/contract/chat-documented-shapes holds them to
 * the DTOs the use cases return.
 */
const chatPerson = z.object({ id: z.string(), name: z.string() });

const chatMessageEntity = z.object({
  id: z.string(),
  kind: z.enum(["TEXT", "IMAGE", "AUDIO"]),
  body: z.string().nullable(),
  attachment_url: z
    .string()
    .nullable()
    .describe("URL assinada de vida curta da foto ou do áudio; a chave de storage nunca sai."),
  duration_ms: z.number().nullable().describe("Duração do áudio."),
  deliveryId: z.string().nullable(),
  routeId: z
    .string()
    .nullable()
    .describe("A rota sobre a qual a mensagem foi dita (decisão 6.7)."),
  broadcast_id: z
    .string()
    .nullable()
    .describe("Igual em todas as cópias de um envio para vários motoristas."),
  client_submission_id: z.string().nullable(),
  threadId: z.string(),
  ticketId: z
    .string()
    .nullable()
    .describe("O atendimento (ticket) da mensagem (decisão 14.5); null só em aviso em massa."),
  senderId: z.string(),
  created_at: isoDateTime,
  sender: chatPerson,
  delivery: z
    .object({ id: z.string(), recipient_name: z.string(), status: z.string() })
    .nullable()
    .describe("A entrega citada na mensagem, já resolvida."),
  route: z
    .object({ id: z.string(), code: z.number().int(), name: z.string().nullable() })
    .nullable()
    .describe("A rota da mensagem, já resolvida; null fora de rota."),
});

const chatSendOutcome = z.object({
  driverId: z.string(),
  driverName: z.string(),
  status: z
    .enum(["SENT", "ALREADY_SENT", "SKIPPED_NO_APP"])
    .describe(
      "SENT: gravada agora. ALREADY_SENT: a mesma chave já tinha gravado (nada foi enviado de novo). SKIPPED_NO_APP: aviso em massa não vai para quem não tem o aplicativo.",
    ),
  messageId: z.string().nullable(),
});

const chatRecipient = z.object({
  id: z.string(),
  name: z.string(),
  hasApp: z
    .boolean()
    .describe(
      "A conta do motorista consegue entrar no aplicativo (existe, não foi revogada e a filial está ativa): só esses recebem o aviso em massa.",
    ),
});

const chatCursor = z.object({ created_at: z.string(), id: z.string() }).nullable();

const chatDocumented = {
  message: chatMessageEntity,
  threadEntry: z.object({
    id: z.string(),
    driver: z.object({ id: z.string(), name: z.string(), cnh: z.string() }),
    driverUser: z
      .object({
        id: z.string(),
        last_seen_at: isoDateTime.nullable(),
        online: z.boolean().describe("Conectado agora, em qualquer réplica."),
      })
      .nullable()
      .describe("A conta do app do motorista; null enquanto ele não tem uma."),
    lastMessage: z
      .object({
        kind: z.enum(["TEXT", "IMAGE", "AUDIO"]),
        body: z.string().nullable(),
        sender: chatPerson,
        created_at: isoDateTime,
      })
      .nullable(),
    unreadCount: z.number().int(),
  }),
  searchHit: chatMessageEntity.extend({ driver: chatPerson }),
  recipient: chatRecipient,
};

// Runtime: pass-through on purpose (see above). Document: the typed shapes.
const chatResponses = {
  threadList: documentedAs(
    z.object({
      data: z.array(z.unknown()),
      total: z.number(),
      totalUnread: z.number(),
    }),
    z.object({
      data: z.array(chatDocumented.threadEntry),
      total: z.number(),
      totalUnread: z.number().describe("Em todas as conversas do escopo, não só na página."),
    }),
  ),
  messageList: documentedAs(z.object({
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

    // Decision 14.5: the tickets cited on the page (subject separators).
    tickets: z.array(z.unknown()),
    counterpartTicketReadAt: z.unknown(),
  }), z.object({
    threadId: z
      .string()
      .nullable()
      .describe("Null quando o motorista ainda não tem conversa: um chat vazio e válido."),
    data: z.array(chatDocumented.message).describe("Mais nova primeiro."),
    nextCursor: chatCursor.describe("Para mensagens mais antigas."),
    previousCursor: chatCursor.describe("Para mensagens mais novas; null no fim da conversa."),
    hasNewer: z.boolean(),
    counterpartLastReadAt: isoDateTime
      .nullable()
      .describe("Até onde o OUTRO lado leu: o duplo check azul."),
    counterpartDeliveredAt: isoDateTime
      .nullable()
      .describe("Até onde o aparelho do motorista recebeu (só para a base): o duplo check cinza."),
    driverUser: z
      .object({ id: z.string(), last_seen_at: isoDateTime.nullable() })
      .nullable(),
    tickets: z
      .array(z.union([ticketSummary, driverTicketViewShape]))
      .describe(
        "Os atendimentos das mensagens desta página, para os separadores de assunto. O motorista recebe a visão reduzida (sem atendente).",
      ),
    counterpartTicketReadAt: z
      .record(z.string(), isoDateTime)
      .describe(
        "Até onde o OUTRO lado leu cada atendimento citado na página (ler um atendimento move só o cursor dele). Uma mensagem está lida quando counterpartLastReadAt OU o cursor do atendimento dela a cobre. Atendimento que o outro lado nunca leu fica de fora.",
      ),
  })),
  messageSent: documentedAs(
    z.object({
      message: z.string().default("Mensagem enviada!"),
      data: z.array(z.unknown()),
      outcomes: z.array(z.unknown()),
      summary: z.unknown(),
    }),
    z.object({
      message: z.string(),
      data: z
        .array(
          chatMessageEntity.extend({
            driver: chatPerson,
            ticket: z
              .object({
                id: z.string(),
                number: z.number().int(),
                status: z.enum(["OPEN", "CLOSED"]),
                assigneeId: z.string().nullable(),
                version: z.number().int(),
              })
              .nullable()
              .describe("O atendimento em que a mensagem caiu; null num aviso em massa."),
            senderSide: z
              .enum(["DRIVER", "STAFF"])
              .describe("Quem escreveu: o motorista ou a central."),
          }),
        )
        .describe(
          "A mensagem de cada conversa alcançada (nova ou já existente): um envio pode ir para vários motoristas.",
        ),
      outcomes: z
        .array(chatSendOutcome)
        .describe("O que aconteceu com cada destinatário, na ordem do envio."),
      summary: z.object({
        sent: z.number().int(),
        alreadySent: z.number().int(),
        skippedNoApp: z.number().int(),
      }),
    }),
  ),
  recipients: documentedAs(
    z.object({
      data: z.array(z.unknown()),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
      audience: z.unknown(),
    }),
    z.object({
      data: z.array(chatRecipient).describe("Motoristas ativos, em ordem alfabética."),
      nextCursor: z
        .string()
        .nullable()
        .describe("Vai como `cursor` na próxima página; null na última."),
      hasMore: z.boolean(),
      audience: z
        .object({ withApp: z.number().int(), withoutApp: z.number().int() })
        .nullable()
        .describe(
          "Motoristas ativos da empresa com e sem o aplicativo, sem a busca. Só na primeira página (sem cursor).",
        ),
    }),
  ),
  markRead: documentedAs(
    z.object({
      message: z.string().default("Conversa marcada como lida."),
      data: z.object({ last_read_at: z.unknown() }),
    }),
    z.object({
      message: z.string(),
      data: z.object({ last_read_at: isoDateTime }),
    }),
  ),
  markDelivered: documentedAs(
    z.object({
      message: z.string().default("Entrega confirmada."),
      data: z.object({ delivered_at: z.unknown(), side: z.unknown() }),
    }),
    z.object({
      message: z.string(),
      data: z.object({
        delivered_at: isoDateTime,
        side: z.enum(["DRIVER", "STAFF"]),
      }),
    }),
  ),
  searchResult: documentedAs(
    z.object({
      data: z.array(z.unknown()),
    }),
    z.object({ data: z.array(chatDocumented.searchHit) }),
  ),
  attachmentUrl: documentedAs(
    z.object({ attachment_url: z.unknown() }),
    z.object({
      attachment_url: z
        .string()
        .nullable()
        .describe("URL assinada de vida curta; null quando a mensagem não tem anexo."),
    }),
  ),
  // The handler's own shape: a narrower schema would strip `code`.
  genericError: errorResponse,
  internalServerError: internalErrorResponse,
};

export { chatSchemas, chatResponses, chatDocumented };

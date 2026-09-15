import {
  ChatDeliverySide,
  ChatMessage,
  ChatMessageSearchHit,
  ChatThread,
  CreateChatMessageProps,
  ListChatMessagesProps,
  ListChatMessagesResult,
  ListChatThreadsProps,
  ListChatThreadsResult,
  SearchChatMessagesProps,
} from "../dtos/chat-dto";

interface IChatRepository {
  findThreadById: (threadId: string) => Promise<ChatThread | null>;
  findThreadByDriver: (
    businessId: string,
    driverId: string,
  ) => Promise<ChatThread | null>;

  /** Upsert on (businessId, driverId): concurrent first messages converge. */
  getOrCreateThread: (
    businessId: string,
    driverId: string,
  ) => Promise<ChatThread>;

  listThreads: (props: ListChatThreadsProps) => Promise<ListChatThreadsResult>;
  listMessages: (
    props: ListChatMessagesProps,
  ) => Promise<ListChatMessagesResult>;
  searchMessages: (
    props: SearchChatMessagesProps,
  ) => Promise<ChatMessageSearchHit[]>;

  /**
   * Inserts and bumps the thread's last_message_at atomically. Accepts the
   * caller's transaction so the outbox publish can commit with the message.
   */
  createMessage: (
    props: CreateChatMessageProps,
    tx?: unknown,
  ) => Promise<ChatMessage>;
  /**
   * A mensagem já criada por esta chave, DENTRO desta empresa.
   *
   * `businessId` não é enfeite aqui. A coluna é única globalmente, e sem o
   * escopo a chave de idempotência virava credencial: quem conhecesse a chave
   * de outra empresa recebia a mensagem dela de volta — corpo, motorista,
   * entrega vinculada, e uma URL assinada NOVA para a foto ou o áudio.
   * As irmãs do abastecimento e do checklist já são `@@unique([businessId,
   * client_submission_id])`; o chat não era, e a consulta também não.
   */
  findMessageBySubmissionId: (
    clientSubmissionId: string,
    businessId: string,
  ) => Promise<ChatMessage | null>;
  findMessageById: (messageId: string) => Promise<ChatMessage | null>;

  /** Advances (never rewinds) the requester's read cursor. */
  markThreadRead: (
    threadId: string,
    userId: string,
    at: Date,
  ) => Promise<void>;

  /** Advances (never rewinds) one side's delivery cursor. */
  markThreadDelivered: (
    threadId: string,
    at: Date,
    side: ChatDeliverySide,
  ) => Promise<void>;
}

export { IChatRepository };

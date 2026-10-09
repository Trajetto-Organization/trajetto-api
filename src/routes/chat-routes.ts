import { FastifyInstance } from "fastify";

import { ListChatThreadsController } from "@/modules/chat/usecases/list-chat-threads/list-chat-threads-controller";
import { ListChatMessagesController } from "@/modules/chat/usecases/list-chat-messages/list-chat-messages-controller";

import { SearchChatMessagesController } from "@/modules/chat/usecases/search-chat-messages/search-chat-messages-controller";
import { SendChatMessageController } from "@/modules/chat/usecases/send-chat-message/send-chat-message-controller";
import { MarkChatReadController } from "@/modules/chat/usecases/mark-chat-read/mark-chat-read-controller";
import { MarkChatDeliveredController } from "@/modules/chat/usecases/mark-chat-delivered/mark-chat-delivered-controller";
import { GetChatAttachmentUrlController } from "@/modules/chat/usecases/get-chat-attachment-url/get-chat-attachment-url-controller";
import { ListChatRecipientsController } from "@/modules/chat/usecases/list-chat-recipients/list-chat-recipients-controller";
import { SupportTicketController } from "@/modules/chat/usecases/tickets/support-ticket-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";
import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";

import { chatSchemas, chatResponses } from "./documentation/chat-documentation";
import {
  panelIdempotencyHeaders,
  requiredPanelIdempotencyHeaders,
} from "./documentation/idempotency-documentation";
import {
  supportTicketResponses,
  supportTicketSchemas,
} from "./documentation/support-ticket-documentation";

const listChatThreadsController = new ListChatThreadsController();
const listChatMessagesController = new ListChatMessagesController();

const searchChatMessagesController = new SearchChatMessagesController();
const sendChatMessageController = new SendChatMessageController();
const markChatReadController = new MarkChatReadController();
const markChatDeliveredController = new MarkChatDeliveredController();
const getChatAttachmentUrlController = new GetChatAttachmentUrlController();
const listChatRecipientsController = new ListChatRecipientsController();
const supportTicketController = new SupportTicketController();

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

/** The refusals every chat route can answer, in the handler's own shape. */
const commonErrors = {
  400: chatResponses.genericError,
  401: chatResponses.genericError,
  403: chatResponses.genericError,
  500: chatResponses.internalServerError,
};

async function chatRoutes(app: FastifyInstance) {
  app.get(
    "/list-threads",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Lista de conversas com os não lidos",
        description:
          "Uma conversa por motorista, a mais recente primeiro, com a prévia da última mensagem, os não lidos de cada uma (sempre derivados do cursor de leitura de quem pede, nunca acumulados), a presença (online / visto por último) e o total de não lidos de todas as conversas para o selo da aba. O token de motorista recebe só a própria conversa.",
        querystring: chatSchemas.listThreads,
        response: {
          200: chatResponses.threadList,
          ...commonErrors,
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
        summary: "Histórico da conversa (paginado por cursor)",
        description:
          "Mensagens da mais nova para a mais antiga, com remetente, entrega e rota citadas e URL assinada do anexo. O par de cursor (beforeAt + beforeId) pagina para o passado; afterAt + afterId, para o presente; aroundMessageId centraliza a página numa mensagem. `deliveryId` e `routeId` filtram o histórico da mesma conversa (decisão 6.7). counterpartLastReadAt diz até onde o OUTRO lado leu. O motorista pode omitir threadId: a conversa dele vem do token; threadId nulo na resposta quer dizer que a conversa ainda não começou. Conversa de outra empresa (ou de outro motorista, para o token de motorista) é tratada como inexistente: 404 CHAT_THREAD_NOT_FOUND, ou a conversa vazia quando o pedido também nomeia o motorista — a mesma resposta de um id que não existe; mensagem de ancoragem inexistente, de outra conversa ou fora do filtro responde 404 CHAT_MESSAGE_NOT_FOUND.",
        querystring: chatSchemas.listMessages,
        response: {
          200: chatResponses.messageList,
          ...commonErrors,
          404: chatResponses.genericError,
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
        summary: "Busca de texto no histórico do chat",
        description:
          "Em todas as conversas para a equipe, só na própria para o token de motorista. Cada resultado traz o motorista da conversa, para a tela abrir direto nela.",
        querystring: chatSchemas.searchMessages,
        response: {
          200: chatResponses.searchResult,
          ...commonErrors,
        },
      },
    },
    searchChatMessagesController.handle,
  );

  app.get(
    "/recipients",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Destinatários do chat (motoristas ativos)",
        description:
          "Os motoristas ativos da empresa para \"Nova conversa\" e para o aviso em massa, em ordem alfabética, com busca por nome no servidor e paginação por cursor (o `nextCursor` volta como `cursor`). Só os campos da escolha (id, nome, `hasApp`), nada do cadastro. `hasApp` diz se a conta do motorista consegue entrar no aplicativo (existe, não foi revogada e a filial está ativa); `app=WITH_APP` ou `app=WITHOUT_APP` lista só um dos lados. Exige `delivery_manage:read` (não a leitura do cadastro de motoristas): a torre que pode enviar também escolhe para quem. A primeira página traz `audience`, a contagem da empresa inteira. Token de motorista recebe 403 PERMISSION_DENIED.",
        querystring: chatSchemas.listRecipients,
        response: {
          200: chatResponses.recipients,
          ...commonErrors,
        },
      },
    },
    listChatRecipientsController.handle,
  );

  app.post(
    "/send-message",
    {
      // Above any real conversation pace, below a runaway loop. The header
      // is documented here (a mass notice's key, IDEMP-14).
      config: {
        rateLimit: { max: 40, timeWindow: "1 minute" },
        openapi: { headers: panelIdempotencyHeaders },
      },
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Enviar mensagem (texto, foto ou áudio) ou aviso em massa",
        description:
          "Cria a conversa no primeiro contato. Vários `driverIds` (repetidos contam uma vez) ou `audience: ALL_ACTIVE_WITH_APP` (todos os motoristas ativos com o aplicativo, resolvidos no servidor) fazem um aviso em massa: uma mensagem independente por conversa, com o mesmo broadcast id, e só para quem tem o aplicativo — os demais voltam como SKIPPED_NO_APP em `outcomes`. O header Idempotency-Key chaveia o aviso por motorista (um retry só envia a quem faltou) e, num envio para um motorista só sem `clientSubmissionId`, é a própria chave da mensagem. Duas requisições simultâneas com a mesma chave respondem a mesma mensagem (ALREADY_SENT), nunca um 500. A mensagem leva a rota informada em `routeId`, ou a rota do motorista que tem a entrega citada, ou a rota em andamento dele. Anexos vêm pelo upload presigned (chatAttachments). A mensagem da equipe também toca o celular do motorista; a do motorista não toca ninguém. Mensagens são registros imutáveis. Motorista, entrega ou rota inexistente — ou de outra empresa, com a mesma resposta — recebe 404 CHAT_DRIVER_NOT_FOUND, CHAT_DELIVERY_NOT_FOUND ou CHAT_ROUTE_NOT_FOUND; um motorista que cita a entrega ou a rota de um colega recebe a mesma resposta. A equipe que cita a rota de outro motorista da empresa recebe 400 CHAT_ROUTE_OTHER_DRIVER. Token MASTER recebe 403 MASTER_CHAT_READ_ONLY. Chave já usada por outra empresa: 409 CHAT_SUBMISSION_CONFLICT. Corpo incompleto para o tipo: 400 CHAT_RECIPIENTS_REQUIRED (nenhum motorista), CHAT_TEXT_REQUIRED (texto vazio), CHAT_ATTACHMENT_REQUIRED (mídia sem anexo), CHAT_AUDIO_DURATION_REQUIRED (áudio sem duração), CHAT_BROADCAST_NOT_TICKET (aviso em massa dentro de um atendimento) ou CHAT_BROADCAST_REFERENCE_NOT_ALLOWED (aviso em massa com chave por envio, entrega ou rota).",
        body: chatSchemas.sendMessage,
        response: {
          201: chatResponses.messageSent,
          ...commonErrors,
          404: chatResponses.genericError,
          409: chatResponses.genericError,
          429: chatResponses.genericError,
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
        summary: "Assinar de novo um anexo",
        description:
          "Uma URL assinada nova para o anexo de uma mensagem. As URLs expiram, e um visualizador aberto por muito tempo mostraria a foto quebrada; recarregar a conversa inteira fecharia o visualizador. Responde null para mensagem sem arquivo. Mensagem inexistente, de outra empresa ou de outra conversa do motorista recebe a mesma resposta: 404 CHAT_MESSAGE_NOT_FOUND (nunca \"não é seu\").",
        querystring: chatSchemas.attachmentUrl,
        response: {
          200: chatResponses.attachmentUrl,
          ...commonErrors,
          404: chatResponses.genericError,
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
        summary: "Avançar o cursor de leitura",
        description:
          "Cada participante tem um cursor por conversa; não lidos e confirmações de leitura derivam dele. Só avança: uma chamada fora de ordem nunca volta o que já foi lido. `readAt` diz até onde o leitor realmente chegou — sem ele o cursor recebe o relógio do servidor. Limitado a agora. Emite chatRead para o outro lado. Token MASTER recebe sucesso sem efeito: nenhum cursor é gravado e nenhum chatRead é emitido. Conversa inexistente ou de outra empresa: 404 CHAT_THREAD_NOT_FOUND.",
        body: chatSchemas.markRead,
        response: {
          200: chatResponses.markRead,
          ...commonErrors,
          404: chatResponses.genericError,
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
        summary: "Confirmar que o aparelho recebeu as mensagens",
        description:
          "Cada lado informa o created_at da mensagem mais nova que o aparelho já guardou; as confirmações do OUTRO lado ficam com o duplo check cinza até ali. O lado vem do token (motorista ou equipe; o da equipe é o mais avançado de qualquer painel aberto). Só avança e é limitado ao relógio do servidor. Token MASTER recebe 403 CHAT_DELIVERY_RECEIPT_NOT_ALLOWED. Emite chatDelivered só para o lado oposto. Conversa inexistente ou de outra empresa: 404 CHAT_THREAD_NOT_FOUND.",
        body: chatSchemas.markDelivered,
        response: {
          200: chatResponses.markDelivered,
          ...commonErrors,
          404: chatResponses.genericError,
        },
      },
    },
    markChatDeliveredController.handle,
  );

  // ================================================== support tickets (14.5)
  // Every subject is a ticket: an occurrence's (opened by the report), a
  // delivery's, a route's or a general one. Same guards as the chat; the
  // tenant guard runs in preHandler (onRequest cannot see the body).
  const ticketErrors = {
    400: supportTicketResponses.error,
    401: supportTicketResponses.error,
    403: supportTicketResponses.error,
    404: supportTicketResponses.error,
    429: supportTicketResponses.error,
    500: chatResponses.internalServerError,
  };

  app.get(
    "/tickets",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Lista de atendimentos (tickets)",
        description:
          "Os atendimentos da empresa, a conversa mais recente primeiro (encerrados: o encerramento mais recente primeiro), com as não lidas de quem pede, a prévia da última mensagem e as contagens dos filtros (abertos, sem atendente, meus, aguardando autorização, abertos com não lidas). `scope` filtra a fila da central (MINE, UNASSIGNED, PENDING_AUTHORIZATION); a busca casa assunto, motorista, destinatário e #número. Token de motorista: só os atendimentos dele, na visão reduzida (sem atendente). MASTER envia `businessId` (sem ele, 400 CHAT_BUSINESS_REQUIRED).",
        querystring: supportTicketSchemas.list,
        response: { 200: supportTicketResponses.list, ...ticketErrors },
      },
    },
    supportTicketController.list,
  );

  app.get(
    "/tickets/summary",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Resumo dos atendimentos (balão e selo da aba)",
        description:
          "As contagens do balão flutuante e do selo da aba Atendimentos: abertos, sem atendente, meus, aguardando autorização e abertos com mensagem não lida por quem pede. É a verdade depois de uma reconexão: o socket é só o aviso. Motorista recebe 403 PERMISSION_DENIED.",
        querystring: supportTicketSchemas.summary,
        response: { 200: supportTicketResponses.summary, ...ticketErrors },
      },
    },
    supportTicketController.summary,
  );

  app.get(
    "/tickets/assignees",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Quem pode atender",
        description:
          "Os operadores da empresa que podem assumir um atendimento (administradores e perfis que escrevem em Entregas, sem motorista vinculado e sem acesso revogado), em ordem alfabética, com busca por nome. Só id e nome. Devolve no máximo 100 pessoas (sem paginação: quem não aparece é achado pela busca). Motorista recebe 403 PERMISSION_DENIED.",
        querystring: supportTicketSchemas.assignees,
        response: { 200: supportTicketResponses.assignees, ...ticketErrors },
      },
    },
    supportTicketController.assignees,
  );

  app.get(
    "/tickets/:ticketId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Detalhe do atendimento",
        description:
          "O atendimento com a ocorrência como foi relatada (fotos assinadas na leitura, respostas do formulário rotuladas, autorização e escalonamento) e o que quem pede pode fazer (`permissions`, com `closeOutcomes`: APPROVED/DENIED com autorização pendente, RESOLVED nos demais). Inexistente, de outra empresa ou, para o motorista, de outro motorista: 404 SUPPORT_TICKET_NOT_FOUND, com o mesmo corpo.",
        params: supportTicketSchemas.params,
        querystring: supportTicketSchemas.masterQuery,
        response: { 200: supportTicketResponses.detail, ...ticketErrors },
      },
    },
    supportTicketController.get,
  );

  app.post(
    "/tickets",
    {
      config: {
        rateLimit: { max: 40, timeWindow: "1 minute" },
        // Required here: the use case refuses a request without it.
        openapi: { headers: requiredPanelIdempotencyHeaders },
      },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Abrir atendimento",
        description:
          "O \"+ Novo atendimento\" da central (motorista e assunto), o \"Abrir atendimento\" de uma entrega, rota ou ocorrência, e o \"Novo assunto\" do motorista. Com `deliveryId` ou `routeId` é um get-or-create: um atendimento aberto por entrega e por rota (201 `created: true` ao criar; 200 `created: false` quando já havia). Header Idempotency-Key (UUID) obrigatório: a mesma chave devolve o mesmo atendimento. `message` grava a primeira mensagem. Erros: 400 IDEMPOTENCY_KEY_REQUIRED, SUPPORT_TICKET_CONTEXT_CONFLICT (entrega e rota juntas), SUPPORT_TICKET_SUBJECT_REQUIRED; 403 MASTER_CHAT_READ_ONLY, DRIVER_CHAT_OWN_THREAD; 404 CHAT_DRIVER_NOT_FOUND, CHAT_DELIVERY_NOT_FOUND, CHAT_ROUTE_NOT_FOUND; 409 CHAT_SUBMISSION_CONFLICT.",
        body: supportTicketSchemas.open,
        response: {
          201: supportTicketResponses.opened,
          200: supportTicketResponses.opened,
          ...ticketErrors,
          409: supportTicketResponses.conflict,
        },
      },
    },
    supportTicketController.open,
  );

  app.post(
    "/tickets/:ticketId/close",
    {
      // Closing may decide an occurrence (push to the driver, webhooks).
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Encerrar atendimento (e decidir a autorização)",
        description:
          "Encerrar o atendimento de uma ocorrência que aguarda autorização É a decisão: `outcome` APPROVED ou DENIED (nota obrigatória ao negar, 400 AUTHORIZATION_NOTE_REQUIRED) passa pelo mesmo caso de uso da fila da torre, que fecha o atendimento na mesma transação. Sem autorização pendente, só RESOLVED. Quem encerra sem atendente vira o atendente. Erros: 409 SUPPORT_TICKET_AUTHORIZATION_PENDING (RESOLVED com pendência), SUPPORT_TICKET_NOT_AUTHORIZATION (APPROVED/DENIED sem pendência), SUPPORT_TICKET_ALREADY_CLOSED (com quem, quando e como), OCCURRENCE_ALREADY_DECIDED (com a decisão que vale). A mesma pessoa repetindo o mesmo desfecho recebe 200 com `replayed: true`. Motorista: 403 PERMISSION_DENIED; MASTER: 403 MASTER_CHAT_READ_ONLY.",
        params: supportTicketSchemas.params,
        querystring: supportTicketSchemas.masterQuery,
        body: supportTicketSchemas.close,
        response: {
          200: supportTicketResponses.closed,
          ...ticketErrors,
          409: supportTicketResponses.conflict,
        },
      },
    },
    supportTicketController.close,
  );

  app.post(
    "/tickets/:ticketId/assign",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Assumir, transferir ou soltar um atendimento",
        description:
          "`assigneeId` = eu (assumir), outro operador (transferir) ou null (soltar). Condicional em `expectedAssigneeId` (o que a tela mostrava): se mudou, 409 SUPPORT_TICKET_ASSIGNEE_CHANGED com o atendente atual. Mesmo atendente: 200 `replayed: true`. Atendente que não é operador desta empresa: 404 SUPPORT_TICKET_ASSIGNEE_NOT_FOUND. Encerrado: 409 SUPPORT_TICKET_CLOSED.",
        params: supportTicketSchemas.params,
        querystring: supportTicketSchemas.masterQuery,
        body: supportTicketSchemas.assign,
        response: {
          200: supportTicketResponses.ticket,
          ...ticketErrors,
          409: supportTicketResponses.conflict,
        },
      },
    },
    supportTicketController.assign,
  );

  app.post(
    "/tickets/:ticketId/reopen",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Reabrir atendimento",
        description:
          "Encerrado volta a aberto. Uma decisão de autorização não é desfeita. Já aberto: 200 `replayed: true`. A conversa anterior aos atendimentos (LEGACY) encerrada não reabre: 409 SUPPORT_TICKET_LEGACY_READ_ONLY. Entrega ou rota com outro atendimento aberto: 409 SUPPORT_TICKET_OPEN_EXISTS.",
        params: supportTicketSchemas.params,
        querystring: supportTicketSchemas.masterQuery,
        body: supportTicketSchemas.reopen,
        response: {
          200: supportTicketResponses.ticket,
          ...ticketErrors,
          409: supportTicketResponses.conflict,
        },
      },
    },
    supportTicketController.reopen,
  );

  app.get(
    "/tickets/:ticketId/events",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Histórico do atendimento",
        description:
          "A trilha imutável do atendimento, em ordem (aberto, atribuído, autorização decidida ou superada, encerrado, reaberto), com o nome das pessoas no momento do fato. Até 500 eventos. Motorista: 403 PERMISSION_DENIED.",
        params: supportTicketSchemas.params,
        querystring: supportTicketSchemas.masterQuery,
        response: { 200: supportTicketResponses.events, ...ticketErrors },
      },
    },
    supportTicketController.events,
  );

  app.get(
    "/tickets/:ticketId/messages",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Mensagens do atendimento (paginado por cursor)",
        description:
          "A mesma paginação de /chat/list-messages, só com as mensagens deste atendimento. Inexistente, de outra empresa ou de outro motorista: 404 SUPPORT_TICKET_NOT_FOUND.",
        params: supportTicketSchemas.params,
        querystring: chatSchemas.listMessages,
        response: { 200: chatResponses.messageList, ...ticketErrors },
      },
    },
    supportTicketController.listMessages,
  );

  app.post(
    "/tickets/:ticketId/messages",
    {
      config: {
        rateLimit: { max: 40, timeWindow: "1 minute" },
        openapi: { headers: panelIdempotencyHeaders },
      },
      onRequest: [ensureAuthenticated],
      // Like every other ticket write: a deactivated company stops writing
      // (TENANT_INACTIVE, decision 4.1) before anything rings a driver.
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Enviar mensagem num atendimento",
        description:
          "Central e motorista. A entrega e a rota da mensagem são as do atendimento. A primeira resposta da central num atendimento sem atendente atribui quem respondeu. Encerrado: 409 SUPPORT_TICKET_CLOSED (com número e data); o app oferece enviar como novo assunto. MASTER: 403 MASTER_CHAT_READ_ONLY. Empresa desativada: 403 TENANT_INACTIVE. `clientSubmissionId` torna o reenvio idempotente.",
        params: supportTicketSchemas.params,
        querystring: supportTicketSchemas.masterQuery,
        body: supportTicketSchemas.messageBody,
        response: {
          201: supportTicketResponses.messageSent,
          ...ticketErrors,
          409: supportTicketResponses.conflict,
        },
      },
    },
    supportTicketController.sendMessage,
  );

  app.post(
    "/tickets/:ticketId/read",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["chat"],
        summary: "Marcar o atendimento como lido",
        description:
          "Avança (nunca recua) o cursor de leitura de quem pede neste atendimento, limitado a agora, e emite chatRead com `ticketId`. MASTER: sucesso sem efeito.",
        params: supportTicketSchemas.params,
        querystring: supportTicketSchemas.masterQuery,
        body: supportTicketSchemas.markRead,
        response: { 200: supportTicketResponses.markRead, ...ticketErrors },
      },
    },
    supportTicketController.markRead,
  );
}

export { chatRoutes };

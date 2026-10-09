import { FastifyInstance } from "fastify";

import { IntegrationAdminController } from "@/modules/integration/usecases/integration-admin/integration-admin-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";

import { MAX_ACTIVE_API_KEYS_PER_BUSINESS } from "@/shared/integration/api-key-rules";
import {
  MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS,
  REPLAY_WINDOW_DAYS,
} from "@/shared/integration/webhook-dispatch-rules";
import { TOPIC_WILDCARDS } from "@/shared/integration/webhook-catalogue";

import {
  integrationSchemas,
  integrationResponses,
} from "./documentation/integration-documentation";
import { errorResponse } from "./documentation/common-responses";
import { ndjsonList } from "./documentation/ndjson";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { MONITOR_LIST_CAP } from "@/schemas/integration-schema";

const controller = new IntegrationAdminController();

/**
 * Every route here looks the session user up first (scopedBusiness): a user
 * deleted mid-session is 404 USER_NOT_FOUND, beside the route's own 404.
 */
const sessionAware = (codes?: string) =>
  errorResponse.describe(
    codes
      ? `${codes} ou USER_NOT_FOUND (o usuário da sessão não existe mais).`
      : "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  );

/**
 * Integrations are part of Entregas (decision 4.3): every topic is a route or
 * document event and the public API already refuses a company without the
 * module (ensure-api-key). A fleet-only company could still issue keys that
 * always answer 403 and point webhooks that never fire (INT-MOD-1, DOCS-12).
 */
const deliveriesModule = verifyModuleEnabled("DELIVERIES");

/**
 * The screens a customer's administrator uses to manage their integrations.
 *
 * Session-authenticated, unlike everything under `/integration/v1`. Managing
 * the credentials of an integration through that integration's own credentials
 * would mean a leaked key can mint more keys — so the person in the browser is
 * the only one who can issue or revoke one.
 *
 * Behind `integration_manage`, not `delivery_manage`: an API key reaches the
 * whole operation of a company, and handing that power to whoever can edit a
 * delivery is handing it to most of the office.
 */
async function integrationAdminRoutes(app: FastifyInstance) {
  app.post(
    "/api-key/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Emitir uma chave de API",
        description: `O token vem NESTA resposta e em nenhum outro lugar, nunca mais. Uma chave que um painel consegue reexibir é uma chave em todo print e todo chamado de suporte. Escopos são separados entre leitura e escrita de propósito: quem concedeu escrita a um sistema que só posta não deveria descobrir, depois de um vazamento, que ele também lia tudo. Os tetos são da plataforma: \`rate_limit_per_minute\` é um inteiro de 10 a 600 para o administrador da empresa (acima disso, só o suporte: 403 \`API_KEY_RATE_ABOVE_PLAN\`), e uma empresa tem no máximo ${MAX_ACTIVE_API_KEYS_PER_BUSINESS} chaves ativas (409 \`API_KEY_LIMIT_REACHED\`; revogar uma libera o lugar).`,
        params: updateDeleteBusinessSchema,
        body: integrationSchemas.createApiKey,
        response: {
          201: integrationResponses.apiKeyCreated,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware(),
          409: errorResponse,
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.createApiKey,
  );

  app.get(
    "/api-keys",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("integration_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Listar as chaves emitidas pela empresa",
        description:
          "Só o prefixo, nunca o segredo. `last_used_at` é o que responde 'esta chave ainda serve?' antes de alguém revogá-la.",
        querystring: integrationSchemas.businessQuery,
        response: {
          200: integrationResponses.apiKeyList,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware(),
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.listApiKeys,
  );

  app.delete(
    "/api-key/:id/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Revogar uma chave",
        description:
          "Revogada, não apagada. Uma chave que fez chamadas é parte da resposta sobre o que aconteceu, e apagá-la levaria a trilha junto. Revogar de novo responde 404.",
        params: integrationSchemas.idParam.merge(updateDeleteBusinessSchema),
        response: {
          200: integrationResponses.resent,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware("API_KEY_NOT_FOUND (inexistente, já revogada ou de outra empresa — a mesma resposta)"),
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.revokeApiKey,
  );

  app.post(
    "/webhook-endpoint/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Cadastrar um endpoint de webhook",
        description: `Só https, com URL de até 2.048 caracteres e alcançável pela internet (endereço interno, de loopback ou \`localhost\` é recusado aqui; um nome que resolve para um endereço interno é recusado a cada envio). Um webhook assinado em texto claro entrega o payload a quem estiver no caminho, e a assinatura prova a origem, não protege o conteúdo. O segredo vem nesta resposta e nunca mais. Tópicos aceitam nomes do catálogo e curingas de um nível (${TOPIC_WILDCARDS.map((wildcard) => `\`${wildcard}\``).join(", ")}), nunca \`*\` puro — que inscreveria a empresa em tópicos que não existiam quando ela concordou — nem um curinga que não é prefixo de tópico (\`document.*\`: "todos os documentos" são \`delivery.*\`, \`occurrence.*\` e \`proof.*\`). No máximo ${MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS} endpoints por empresa, pausados incluídos (409 \`WEBHOOK_ENDPOINT_LIMIT_REACHED\`).`,
        params: updateDeleteBusinessSchema,
        body: integrationSchemas.saveWebhookEndpoint,
        response: {
          201: integrationResponses.webhookEndpointSaved,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware(),
          409: errorResponse,
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.saveWebhookEndpoint,
  );

  app.put(
    "/webhook-endpoint/:id/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Editar um endpoint de webhook",
        description: `Editar é alguém dizendo que consertou: a contagem de falhas em sequência e o nosso próprio desligamento voltam a zero junto, e os eventos retidos enquanto o endpoint estava desligado ou pausado (até ${REPLAY_WINDOW_DAYS} dias) saem na hora. \`is_active: false\` pausa: eventos que acontecerem durante a pausa NÃO são gravados nem enviados depois; os que já estavam na fila esperam a reativação. Para só religar um endpoint desligado por falhas, sem editar nada, use \`POST …/reactivate\`. Omitir \`headers\` mantém os atuais; \`null\` apaga. O segredo não é regerado nem reexibido — trocá-lo quebraria a verificação do receptor sem avisar ninguém.`,
        params: integrationSchemas.idParam.merge(updateDeleteBusinessSchema),
        body: integrationSchemas.saveWebhookEndpoint,
        response: {
          200: integrationResponses.webhookEndpointSaved,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware("WEBHOOK_ENDPOINT_NOT_FOUND (inexistente ou de outra empresa — a mesma resposta)"),
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.saveWebhookEndpoint,
  );

  app.post(
    "/webhook-endpoint/:id/business/:businessId/reactivate",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("integration_manage", "write"),
      ],
      // Deliberate and rare; each call can release a month of held events.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Reativar um endpoint desligado por falhas",
        description: `Religa o que o NOSSO disjuntor desligou (\`disabled_at\`, depois de falhas seguidas, de um 410 ou de um redirecionamento): zera a contagem de falhas e envia na hora os eventos retidos nos últimos ${REPLAY_WINDOW_DAYS} dias. Não muda nome, URL, tópicos nem o interruptor do cliente: um endpoint pausado continua pausado (os retidos saem quando ele for ativado na edição). Chamar de novo, ou num endpoint que não está desligado, responde 200 com \`reactivated: false\`.`,
        params: integrationSchemas.idParam.merge(updateDeleteBusinessSchema),
        response: {
          200: integrationResponses.webhookEndpointReactivated,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware("WEBHOOK_ENDPOINT_NOT_FOUND (inexistente ou de outra empresa — a mesma resposta)"),
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.reactivateWebhookEndpoint,
  );

  app.post(
    "/webhook-endpoint/:id/business/:businessId/rotate-secret",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("integration_manage", "write"),
      ],
      // Issuing a secret is rare and deliberate; a loop doing it is not.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Gerar um novo segredo de assinatura",
        description:
          "Gera um segredo novo e o devolve NESTA resposta, uma única vez, como no cadastro. O anterior continua assinando junto por 24 horas: durante esse prazo o `X-Trajetto-Signature` leva dois `v1`, um por segredo, e o receptor aceita a chamada se qualquer um deles conferir — então dá para trocar a chave do lado de lá sem perder eventos. Trocar de novo dentro do prazo descarta o mais antigo. Antes disto, trocar o segredo exigia apagar o endpoint e, com ele, todo o histórico de entregas.",
        params: integrationSchemas.idParam.merge(updateDeleteBusinessSchema),
        response: {
          200: integrationResponses.webhookEndpointSaved,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware("WEBHOOK_ENDPOINT_NOT_FOUND (inexistente ou de outra empresa — a mesma resposta)"),
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.rotateWebhookSecret,
  );

  app.get(
    "/webhook-endpoints",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("integration_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Listar os endpoints de webhook da empresa",
        description:
          "`disabled_at` é o nosso desligamento depois de falhas demais em sequência, e é diferente de `is_active`, que é o interruptor do cliente. Um endpoint morto custa a cada evento um timeout de dez segundos, e a cem eventos por hora isso é um worker sem fazer mais nada.",
        querystring: integrationSchemas.businessQuery,
        response: {
          200: integrationResponses.webhookEndpointList,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware(),
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.listWebhookEndpoints,
  );

  app.delete(
    "/webhook-endpoint/:id/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Remover um endpoint de webhook",
        description:
          "O histórico de entregas dele vai junto, por cascade: são chamadas para uma URL que a empresa decidiu não usar mais, e mantê-las seria guardar o corpo de respostas de um sistema que já não é assunto de ninguém.",
        params: integrationSchemas.idParam.merge(updateDeleteBusinessSchema),
        response: {
          200: integrationResponses.resent,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware("WEBHOOK_ENDPOINT_NOT_FOUND (inexistente ou de outra empresa — a mesma resposta)"),
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.deleteWebhookEndpoint,
  );

  app.get(
    "/webhook-deliveries",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("integration_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Monitor de envios: o que mandamos e o que responderam",
        description: `Responde em application/x-ndjson, NÃO em JSON: a primeira linha é o envelope \`{meta:{total,page,pageSize,searchMeta}}\` e cada linha seguinte é uma entrega. Lista e contadores usam o MESMO período (\`window\`: 24h, 7d ou 30d, pela criação do evento): \`delivered\` e \`failed\` são os eventos do período entregues e com falha, \`pending\` é a fila inteira (PENDING e PROCESSING) qualquer que seja a idade, e \`p95LatencyMs\` é o tempo de resposta do receptor no percentil 95 das MESMAS entregas contadas em \`delivered\` (não inclui tempo de fila nem falhas). Sem \`status\`, a lista traz a fila mais os concluídos do período, e o \`total\` é a soma dos três contadores. A lista conta e pagina até ${MONITOR_LIST_CAP.toLocaleString("pt-BR")} envios: acima disso \`total\` vale ${MONITOR_LIST_CAP.toLocaleString("pt-BR")} e \`searchMeta.totalCapped\` vem \`true\` (os contadores continuam exatos); uma página além desse limite responde 400 MONITOR_PAGE_OUT_OF_RANGE — filtre por status, endpoint ou período. \`status=QUEUED\` lista a fila inteira, como o contador. O corpo da resposta deles vem truncado no primeiro kilobyte — é onde está o erro. Entregas concluídas são apagadas depois de 31 dias, e as dos últimos ${REPLAY_WINDOW_DAYS} dias podem ser reenviadas.`,
        querystring: integrationSchemas.listWebhookDeliveries,
        response: {
          200: ndjsonList(
            integrationResponses.webhookDeliveryRow,
            integrationResponses.webhookDeliveryEnvelope.shape.meta,
          ),
          400: errorResponse,
          403: errorResponse,
          404: sessionAware(),
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.listWebhookDeliveries,
  );

  app.get(
    "/api-usage",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("integration_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Uso da API: o que o sistema do cliente pediu",
        description:
          "`webhook_delivery` responde o que MANDAMOS; isto responde o que eles PEDIRAM — que é a pergunta que chega primeiro no suporte. Agregado por dia, método e rota: a cinco milhões de entregas por mês um log por requisição seria dezenas de milhões de linhas por mês para responder uma pergunta que é sempre contagem. Os dias são os do calendário da empresa (`Business.timezone`, devolvido em `timeZone`): \"hoje\" (`days=1`) é o dia que a empresa está vivendo, não o dia UTC. Contagens gravadas antes de 28/09/2026 estão no dia UTC. A rota é o PADRÃO (`/deliveries/:id`) e não a URL, senão seria uma linha por documento consultado. As classes são 2, 4 e 5 — funcionou, o cliente errou, nós erramos. Dias sem chamada nenhuma vêm com zero em vez de faltar, porque um gráfico que pula o dia desenha uma reta por cima de um fim de semana em que a integração estava fora.",
        querystring: integrationSchemas.listApiUsage,
        response: {
          200: integrationResponses.apiUsage,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware(),
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.listApiUsage,
  );

  app.post(
    "/webhook-delivery/:id/business/:businessId/resend",
    {
      // Every call queues one more POST to the customer's endpoint; a loop of
      // resends is a flood aimed at their system from ours.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Reenviar um evento",
        description: `Cria uma linha NOVA em vez de reabrir a antiga: o registro do que foi enviado e do que o servidor deles respondeu na primeira vez é a primeira coisa que alguém pede quando reclamam de duplicata. Fora da janela de ${REPLAY_WINDOW_DAYS} dias responde 409 com a frase, em vez de não fazer nada em silêncio — quem apertou reenviar num evento de dois meses precisa saber por que nada aconteceu. Para um endpoint pausado ou desligado o reenvio é aceito mas fica retido até o endpoint ser reativado, e a mensagem diz isso.`,
        params: integrationSchemas.idParam.merge(updateDeleteBusinessSchema),
        response: {
          200: integrationResponses.resendScheduled,
          400: errorResponse,
          403: errorResponse,
          404: sessionAware("WEBHOOK_DELIVERY_NOT_FOUND (inexistente ou de outra empresa — a mesma resposta)"),
          409: errorResponse,
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.resendWebhookDelivery,
  );
}

export { integrationAdminRoutes };

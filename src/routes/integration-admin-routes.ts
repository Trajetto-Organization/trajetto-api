import { FastifyInstance } from "fastify";

import { IntegrationAdminController } from "@/modules/integration/usecases/integration-admin/integration-admin-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";

import {
  integrationSchemas,
  integrationResponses,
} from "./documentation/integration-documentation";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

const controller = new IntegrationAdminController();

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
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Issue an API key",
        description:
          "O token vem NESTA resposta e em nenhum outro lugar, nunca mais. Uma chave que um painel consegue reexibir é uma chave em todo print e todo chamado de suporte. Escopos são separados entre leitura e escrita de propósito: quem concedeu escrita a um sistema que só posta não deveria descobrir, depois de um vazamento, que ele também lia tudo.",
        params: updateDeleteBusinessSchema,
        body: integrationSchemas.createApiKey,
        response: {
          201: integrationResponses.apiKeyCreated,
          400: integrationResponses.genericError,
          403: integrationResponses.genericError,
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
      preHandler: [verifyPermission("integration_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "The keys this company issued",
        description:
          "Só o prefixo, nunca o segredo. `last_used_at` é o que responde 'esta chave ainda serve?' antes de alguém revogá-la.",
        response: {
          200: integrationResponses.apiKeyList,
          400: integrationResponses.genericError,
          403: integrationResponses.genericError,
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
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Revoke a key",
        description:
          "Revogada, não apagada. Uma chave que fez chamadas é parte da resposta sobre o que aconteceu, e apagá-la levaria a trilha junto. Revogar de novo responde 404.",
        params: integrationSchemas.idParam.merge(updateDeleteBusinessSchema),
        response: {
          200: integrationResponses.resent,
          400: integrationResponses.genericError,
          403: integrationResponses.genericError,
          404: integrationResponses.genericError,
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
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Point a webhook somewhere",
        description:
          "Só https: um webhook assinado em texto claro entrega o payload a quem estiver no caminho, e a assinatura prova a origem, não protege o conteúdo. O segredo vem nesta resposta e nunca mais. Tópicos aceitam nomes do catálogo e curinga de um nível (`delivery.*`), nunca `*` puro — que inscreveria a empresa em tópicos que não existiam quando ela concordou.",
        params: updateDeleteBusinessSchema,
        body: integrationSchemas.saveWebhookEndpoint,
        response: {
          201: integrationResponses.webhookEndpointSaved,
          400: integrationResponses.genericError,
          403: integrationResponses.genericError,
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
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Edit an endpoint",
        description:
          "Editar é alguém dizendo que consertou: a contagem de falhas em sequência e o nosso próprio desligamento voltam a zero junto. O segredo não é regerado nem reexibido — trocá-lo quebraria a verificação do receptor sem avisar ninguém.",
        params: integrationSchemas.idParam.merge(updateDeleteBusinessSchema),
        body: integrationSchemas.saveWebhookEndpoint,
        response: {
          200: integrationResponses.webhookEndpointSaved,
          400: integrationResponses.genericError,
          403: integrationResponses.genericError,
          404: integrationResponses.genericError,
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.saveWebhookEndpoint,
  );

  app.get(
    "/webhook-endpoints",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("integration_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "The endpoints this company registered",
        description:
          "`disabled_at` é o nosso desligamento depois de falhas demais em sequência, e é diferente de `is_active`, que é o interruptor do cliente. Um endpoint morto custa a cada evento um timeout de dez segundos, e a cem eventos por hora isso é um worker sem fazer mais nada.",
        response: {
          200: integrationResponses.webhookEndpointList,
          400: integrationResponses.genericError,
          403: integrationResponses.genericError,
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
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Remove an endpoint",
        description:
          "O histórico de entregas dele vai junto, por cascade: são chamadas para uma URL que a empresa decidiu não usar mais, e mantê-las seria guardar o corpo de respostas de um sistema que já não é assunto de ninguém.",
        params: integrationSchemas.idParam.merge(updateDeleteBusinessSchema),
        response: {
          200: integrationResponses.resent,
          400: integrationResponses.genericError,
          403: integrationResponses.genericError,
          404: integrationResponses.genericError,
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
      preHandler: [verifyPermission("integration_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "The monitor: what we sent and what they answered",
        description:
          "Responde em application/x-ndjson, NÃO em JSON: a primeira linha é o envelope `{meta:{total,page,pageSize,searchMeta}}` e cada linha seguinte é uma entrega. O corpo da resposta deles vem truncado no primeiro kilobyte — é onde está o erro, e guardar mais significaria uma página de HTML multiplicada por cada evento do dia. `searchMeta.p95LatencyMs` é sobre as últimas 24h e é o número que se pergunta quando o sistema do cliente parece lento.",
        querystring: integrationSchemas.listWebhookDeliveries,
        response: {
          200: integrationResponses.webhookDeliveryEnvelope,
          400: integrationResponses.genericError,
          403: integrationResponses.genericError,
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
      preHandler: [verifyPermission("integration_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "O outro lado do monitor: o que o sistema do cliente pediu",
        description:
          "`webhook_delivery` responde o que MANDAMOS; isto responde o que eles PEDIRAM — que é a pergunta que chega primeiro no suporte. Agregado por dia, método e rota: a cinco milhões de entregas por mês um log por requisição seria dezenas de milhões de linhas por mês para responder uma pergunta que é sempre contagem. A rota é o PADRÃO (`/deliveries/:id`) e não a URL, senão seria uma linha por documento consultado. As classes são 2, 4 e 5 — funcionou, o cliente errou, nós erramos. Dias sem chamada nenhuma vêm com zero em vez de faltar, porque um gráfico que pula o dia desenha uma reta por cima de um fim de semana em que a integração estava fora.",
        querystring: integrationSchemas.listApiUsage,
        response: {
          200: integrationResponses.apiUsage,
          400: integrationResponses.genericError,
          403: integrationResponses.genericError,
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.listApiUsage,
  );

  app.post(
    "/webhook-delivery/:id/business/:businessId/resend",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("integration_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["integration-admin"],
        summary: "Send one event again",
        description:
          "Cria uma linha NOVA em vez de reabrir a antiga: o registro do que foi enviado e do que o servidor deles respondeu na primeira vez é a primeira coisa que alguém pede quando reclamam de duplicata. Fora da janela de 30 dias responde 409 com a frase, em vez de não fazer nada em silêncio — quem apertou reenviar num evento de dois meses precisa saber por que nada aconteceu.",
        params: integrationSchemas.idParam.merge(updateDeleteBusinessSchema),
        response: {
          200: integrationResponses.resent,
          400: integrationResponses.genericError,
          403: integrationResponses.genericError,
          404: integrationResponses.genericError,
          409: integrationResponses.genericError,
          500: integrationResponses.internalServerError,
        },
      },
    },
    controller.resendWebhookDelivery,
  );
}

export { integrationAdminRoutes };

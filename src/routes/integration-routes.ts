import { FastifyInstance } from "fastify";

import { IntegrationReadController } from "@/modules/integration/usecases/integration-read/integration-read-controller";

import { ensureApiKey, verifyApiScope } from "@/modules/middlewares/ensure-api-key";

import {
  integrationSchemas,
  integrationResponses,
  buildCatalogue,
} from "./documentation/integration-documentation";

import {
  TOPIC_FAMILY,
  WEBHOOK_API_VERSION,
} from "@/shared/integration/webhook-catalogue";

import { apiUsageRecorder } from "@/shared/integration/api-usage-recorder";

const readController = new IntegrationReadController();

/**
 * The public API, version one.
 *
 * Nothing here reads a session cookie and nothing takes a `businessId`: the
 * company comes from the API KEY and from nowhere else. A public API that
 * accepted the company as a parameter would be a public API where one customer
 * can ask for another's operation — and it would pass every test written by
 * somebody who only ever sent their own id.
 *
 * The rate limit is PER KEY, not per company: one integration hammering us
 * must not spend the budget of another integration belonging to the same
 * customer.
 *
 * Every list pages by cursor. An ERP pulling a whole operation walks hundreds
 * of pages, `OFFSET 40000` makes Postgres count forty thousand rows to throw
 * them away, and — the part that actually loses documents — an offset page
 * shifts when a row is inserted mid-walk.
 */
async function integrationRoutes(app: FastifyInstance) {
  /**
   * Counts every answered call, for the monitor.
   *
   * `onResponse` and not `onSend`: the number that matters is the one the
   * customer's system actually received, including the 401 that never reached
   * a handler. Scoped to this plugin, so the panel's own traffic — a person in
   * a browser — never lands in a customer's integration usage.
   *
   * The route PATTERN, so `/deliveries/:id` stays one bucket rather than one
   * per document anybody looked at.
   */
  app.addHook("onResponse", async (request, reply) => {
    if (!request.apiKey) return;

    apiUsageRecorder.record({
      apiKeyId: request.apiKey.id,
      businessId: request.apiKey.businessId,
      method: request.method,
      route: request.routeOptions?.url ?? request.url,
      status: reply.statusCode,
    });
  });

  app.get(
    "/catalogue",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["integration"],
        summary: "Every topic and scope this version publishes",
        description:
          "Aberto, sem chave: é a lista que alguém lê ANTES de integrar. Gerado das mesmas constantes que o despachante usa para casar assinaturas, então não pode divergir do que realmente é enviado. Mudança aditiva não quebra assinante; incompatível vira versão nova.",
        response: {
          200: integrationResponses.catalogue,
          500: integrationResponses.internalServerError,
        },
      },
    },
    async (_request, reply) =>
      reply
        .header("Cache-Control", "public, max-age=300")
        .status(200)
        .send(buildCatalogue(WEBHOOK_API_VERSION, TOPIC_FAMILY)),
  );

  app.get(
    "/deliveries",
    {
      onRequest: [ensureApiKey],
      preHandler: [verifyApiScope("deliveries:read")],
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",

          // Per key, not per IP: several customers behind one corporate NAT
          // would otherwise share — and spend — one budget.
          keyGenerator: (request) =>
            request.apiKey?.prefix ?? request.ip,
        },
      },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        summary: "The deliveries of the company this key belongs to",
        description:
          "Paginação por CURSOR: passe o `next_cursor` da resposta anterior em `cursor`. `updated_since` (ISO 8601) traz só o que mudou, que é o que um ERP usa para sincronizar sem reler tudo. Cada objeto carrega os TRÊS identificadores — o nosso id, o `code` do seu ERP e a chave da NF-e quando existir — porque uma integração que só casa por um deles quebra na primeira vez que o ERP do cliente muda como numera as coisas.",
        querystring: integrationSchemas.list,
        response: {
          200: integrationResponses.deliveryPage,
          401: integrationResponses.genericError,
          403: integrationResponses.genericError,
          429: integrationResponses.genericError,
          500: integrationResponses.internalServerError,
        },
      },
    },
    readController.listDeliveries,
  );

  app.get(
    "/deliveries/:id",
    {
      onRequest: [ensureApiKey],
      preHandler: [verifyApiScope("deliveries:read")],
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.apiKey?.prefix ?? request.ip,
        },
      },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        summary: "One delivery",
        description:
          "Uma entrega de outra empresa responde o mesmo 404 de uma que não existe: uma resposta diferente deixaria um cliente confirmar os ids de outro.",
        params: integrationSchemas.idParam,
        response: {
          200: integrationResponses.delivery,
          401: integrationResponses.genericError,
          403: integrationResponses.genericError,
          404: integrationResponses.genericError,
          429: integrationResponses.genericError,
          500: integrationResponses.internalServerError,
        },
      },
    },
    readController.getDelivery,
  );

  app.get(
    "/routes",
    {
      onRequest: [ensureApiKey],
      preHandler: [verifyApiScope("routes:read")],
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.apiKey?.prefix ?? request.ip,
        },
      },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        summary: "The routes of the company this key belongs to",
        description:
          "Mesma paginação por cursor das entregas. As paradas vêm na ordem que o despachante escolheu, com a entrega de cada uma pelos três identificadores.",
        querystring: integrationSchemas.list,
        response: {
          200: integrationResponses.routePage,
          401: integrationResponses.genericError,
          403: integrationResponses.genericError,
          429: integrationResponses.genericError,
          500: integrationResponses.internalServerError,
        },
      },
    },
    readController.listRoutes,
  );

  app.get(
    "/routes/:id",
    {
      onRequest: [ensureApiKey],
      preHandler: [verifyApiScope("routes:read")],
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.apiKey?.prefix ?? request.ip,
        },
      },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        summary: "One route",
        description:
          "Uma rota de outra empresa responde o mesmo 404 de uma que não existe.",
        params: integrationSchemas.idParam,
        response: {
          200: integrationResponses.route,
          401: integrationResponses.genericError,
          403: integrationResponses.genericError,
          404: integrationResponses.genericError,
          429: integrationResponses.genericError,
          500: integrationResponses.internalServerError,
        },
      },
    },
    readController.getRoute,
  );

  app.get(
    "/events",
    {
      onRequest: [ensureApiKey],
      preHandler: [verifyApiScope("events:read")],
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.apiKey?.prefix ?? request.ip,
        },
      },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        summary: "What happened, for an integration that polls",
        description:
          "Oferecido AO LADO dos webhooks e não no lugar deles: um cliente atrás de firewall não consegue receber uma chamada, e dizer a ele 'exponha um endpoint ou fique sem nada' é como um projeto de integração morre. Lê dos eventos da entrega e não do outbox — o outbox é expurgado, e quem consulta uma semana de histórico não pode encontrar um buraco onde a limpeza passou.",
        querystring: integrationSchemas.list,
        response: {
          200: integrationResponses.eventPage,
          401: integrationResponses.genericError,
          403: integrationResponses.genericError,
          429: integrationResponses.genericError,
          500: integrationResponses.internalServerError,
        },
      },
    },
    readController.listEvents,
  );
}

export { integrationRoutes };

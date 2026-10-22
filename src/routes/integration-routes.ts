import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { IntegrationReadController } from "@/modules/integration/usecases/integration-read/integration-read-controller";
import { CreateIntegrationDeliveryController } from "@/modules/integration/usecases/create-delivery/create-integration-delivery-controller";

import {
  ensureApiKey,
  verifyApiScope,
} from "@/modules/middlewares/ensure-api-key";

import { rateLimitExceeded } from "@/config/rate-limit";
import { BUSINESS_API_RATE_PER_MINUTE } from "@/shared/integration/api-key-rules";
import {
  INTEGRATION_RATE_WINDOW_SECONDS,
  integrationRateGuard,
} from "@/shared/integration/integration-rate-guard";

import {
  integrationSchemas,
  integrationResponses,
  buildCatalogue,
} from "./documentation/integration-documentation";

import {
  CREATE_DELIVERY_REQUEST_EXAMPLE,
  integrationWriteResponses,
  integrationWriteSchemas,
} from "./documentation/integration-write-documentation";
import {
  publicBadRequestResponse,
  publicBusinessRateLimitResponse,
  publicInternalErrorResponse,
  publicNotFoundResponse,
  publicServiceUnavailableResponse,
} from "./documentation/public-docs-responses";

import {
  TOPIC_FAMILY,
  WEBHOOK_API_VERSION,
} from "@/shared/integration/webhook-catalogue";

import { apiUsageRecorder } from "@/shared/integration/api-usage-recorder";

const readController = new IntegrationReadController();
const createDeliveryController = new CreateIntegrationDeliveryController();

const COMPANY_REFUSAL_HIDDEN_HEADERS = [
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
] as const;

/**
 * The company's budget, shared by all of its keys.
 *
 * The per-key ceiling bounds one integration; it never bounded a company,
 * which could hold as many keys as it liked, each at its own ceiling. This is
 * the number that caps one tenant's share of the database whatever its keys
 * say. It runs after the per-key limiter, so a call already refused for its
 * key does not also spend the company's minute. Redis counters only, failing
 * open (ADR 0002).
 */
async function limitBusinessApiRate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const businessId = request.apiKey?.businessId;

  if (!businessId) return;

  if (
    await integrationRateGuard.allowBusiness(
      businessId,
      BUSINESS_API_RATE_PER_MINUTE,
    )
  ) {
    return;
  }

  // The per-key limiter ran first and left the KEY's x-ratelimit-* on the
  // reply; on this refusal they would read "remaining 119" and invite the
  // client to keep calling. Only retry-after describes it (as documented).
  for (const header of COMPANY_REFUSAL_HIDDEN_HEADERS)
    reply.removeHeader(header);

  // A fixed window: waiting this long always finds it reset.
  reply.header("retry-after", String(INTEGRATION_RATE_WINDOW_SECONDS));

  throw rateLimitExceeded(
    "A empresa desta chave atingiu o limite de requisições por minuto, somado entre todas as chaves dela. Tente novamente em um minuto.",
  );
}

/**
 * The public API, version one.
 *
 * Nothing here reads a session cookie and nothing takes a `businessId`: the
 * company comes from the API KEY and from nowhere else. A public API that
 * accepted the company as a parameter would be a public API where one customer
 * can ask for another's operation — and it would pass every test written by
 * somebody who only ever sent their own id.
 *
 * The rate limit is PER KEY first: one integration hammering us must not
 * spend the budget of another integration belonging to the same customer.
 * Above it sits one budget per COMPANY (limitBusinessApiRate), so a company
 * cannot multiply its share of the platform by holding more keys.
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
      timeZone: request.apiKey.timeZone,
      method: request.method,
      route: request.routeOptions?.url ?? request.url,
      status: reply.statusCode,
    });
  });

  /**
   * THE KEY'S ceiling, not a fixed number — and ONE ceiling for the key.
   *
   * `rate_limit_per_minute` was stored on the key, editable through an
   * administration route and published in the schema — and no limiter ever
   * read it. A key provisioned at 60/min got 600. Then, once read, it was
   * declared on each route, and @fastify/rate-limit gives every route its own
   * bucket: a key at 60/min got 60/min on EACH of the five endpoints. A limit
   * the product promises and does not enforce is worse than none: somebody
   * sizes their integration trusting it.
   *
   * `app.rateLimit()` builds a handler with a single bucket, shared by every
   * route that uses it; the routes opt out of the plugin's own per-route hook
   * (`rateLimit: false`). It runs after `ensureApiKey`, which resolves the
   * key; floods of invalid keys are bounded there, by address.
   *
   * Per key, not per IP: several customers behind one corporate NAT would
   * otherwise share — and spend — one budget. Namespaced, so no other
   * `app.rateLimit()` user can land in the same bucket.
   */
  const perKeyCeiling = app.rateLimit({
    // The fallback only applies if the key is somehow unresolved.
    max: (request) => request.apiKey?.rateLimitPerMinute ?? 600,
    timeWindow: "1 minute",
    keyGenerator: (request) =>
      `integration-key:${request.apiKey?.prefix ?? request.ip}`,
  });

  app.get(
    "/catalogue",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["integration"],
        // Stable names for code generators; the public portal links by them.
        operationId: "getCatalogue",
        summary: "Catálogo de tópicos e escopos",
        description:
          "Aberto, sem chave: é a lista que alguém lê ANTES de integrar. Gerado das mesmas constantes que o despachante usa para casar assinaturas, então não pode divergir do que realmente é enviado. Mudança aditiva não quebra assinante; incompatível vira versão nova.",
        response: {
          200: integrationResponses.catalogue,
          500: publicInternalErrorResponse,
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
      onRequest: [ensureApiKey, perKeyCeiling, limitBusinessApiRate],
      preHandler: [verifyApiScope("deliveries:read")],
      // The key's single ceiling is `perKeyCeiling`, above.
      config: { rateLimit: false },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        operationId: "listDeliveries",
        // The hook above enforces it; this only publishes it.
        "x-scopes": ["deliveries:read"],
        summary: "Listar entregas",
        description:
          "Paginação por CURSOR: passe o `next_cursor` da resposta anterior em `cursor`. A ordem é a do `id`, crescente (UUID v7, a ordem de criação). `updated_since` (ISO 8601) traz só o que mudou a partir daquele instante (`updated_at` maior ou igual), que é o que um ERP usa para sincronizar sem reler tudo. Cada objeto carrega os TRÊS identificadores — o nosso id, o `code` do seu ERP e a chave da NF-e quando existir — porque uma integração que só casa por um deles quebra na primeira vez que o ERP do cliente muda como numera as coisas.",
        querystring: integrationSchemas.listDeliveries,
        // 401, 403 and the key's 429 come from ensureApiKey, through the
        // OpenAPI transform, with their codes.
        response: {
          200: integrationResponses.deliveryPage,
          400: publicBadRequestResponse,
          429: publicBusinessRateLimitResponse,
          500: publicInternalErrorResponse,
          503: publicServiceUnavailableResponse,
        },
      },
    },
    readController.listDeliveries,
  );

  app.get(
    "/deliveries/:id",
    {
      onRequest: [ensureApiKey, perKeyCeiling, limitBusinessApiRate],
      preHandler: [verifyApiScope("deliveries:read")],
      config: { rateLimit: false },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        operationId: "getDelivery",
        "x-scopes": ["deliveries:read"],
        summary: "Consultar uma entrega",
        description:
          "Uma entrega de outra empresa responde o mesmo 404 de uma que não existe: uma resposta diferente deixaria um cliente confirmar os ids de outro.",
        params: integrationSchemas.idParam,
        response: {
          200: integrationResponses.delivery,
          400: publicBadRequestResponse,
          404: publicNotFoundResponse,
          429: publicBusinessRateLimitResponse,
          500: publicInternalErrorResponse,
          503: publicServiceUnavailableResponse,
        },
      },
    },
    readController.getDelivery,
  );

  app.get(
    "/routes",
    {
      onRequest: [ensureApiKey, perKeyCeiling, limitBusinessApiRate],
      preHandler: [verifyApiScope("routes:read")],
      config: { rateLimit: false },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        operationId: "listRoutes",
        "x-scopes": ["routes:read"],
        summary: "Listar rotas",
        description:
          "Mesma paginação por cursor das entregas, na ordem do `id` crescente (a ordem de criação); `updated_since` filtra por `updated_at` maior ou igual. As paradas vêm na ordem que o despachante escolheu, com a entrega de cada uma pelos três identificadores.",
        querystring: integrationSchemas.listRoutes,
        response: {
          200: integrationResponses.routePage,
          400: publicBadRequestResponse,
          429: publicBusinessRateLimitResponse,
          500: publicInternalErrorResponse,
          503: publicServiceUnavailableResponse,
        },
      },
    },
    readController.listRoutes,
  );

  app.get(
    "/routes/:id",
    {
      onRequest: [ensureApiKey, perKeyCeiling, limitBusinessApiRate],
      preHandler: [verifyApiScope("routes:read")],
      config: { rateLimit: false },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        operationId: "getRoute",
        "x-scopes": ["routes:read"],
        summary: "Consultar uma rota",
        description:
          "Uma rota de outra empresa responde o mesmo 404 de uma que não existe.",
        params: integrationSchemas.idParam,
        response: {
          200: integrationResponses.route,
          400: publicBadRequestResponse,
          404: publicNotFoundResponse,
          429: publicBusinessRateLimitResponse,
          500: publicInternalErrorResponse,
          503: publicServiceUnavailableResponse,
        },
      },
    },
    readController.getRoute,
  );

  app.get(
    "/events",
    {
      onRequest: [ensureApiKey, perKeyCeiling, limitBusinessApiRate],
      preHandler: [verifyApiScope("events:read")],
      config: { rateLimit: false },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        operationId: "listEvents",
        "x-scopes": ["events:read"],
        summary: "Listar eventos (polling)",
        description:
          "Oferecido AO LADO dos webhooks e não no lugar deles: um cliente atrás de firewall não consegue receber uma chamada, e dizer a ele 'exponha um endpoint ou fique sem nada' é como um projeto de integração morre. Lê do histórico permanente das entregas: consultar uma semana para trás não encontra buracos. Ordem do `id` crescente; aqui `updated_since` filtra pela hora em que o evento chegou ao Trajetto (`created_at` maior ou igual), não por `occurred_at`.",
        querystring: integrationSchemas.listEvents,
        response: {
          200: integrationResponses.eventPage,
          400: publicBadRequestResponse,
          429: publicBusinessRateLimitResponse,
          500: publicInternalErrorResponse,
          503: publicServiceUnavailableResponse,
        },
      },
    },
    readController.listEvents,
  );

  /**
   * The one write of v1 (decision 5.10): an ERP pushes a document.
   *
   * The same gates as the reads — the key, its ceiling, the company's
   * ceiling — and its own scope, checked before the body is even read: a key
   * that cannot write learns nothing about what a valid body looks like. The
   * body is parsed in the controller, not by Fastify, so every refusal names
   * its field (see create-integration-delivery-schema).
   */
  app.post(
    "/deliveries",
    {
      onRequest: [ensureApiKey, perKeyCeiling, limitBusinessApiRate],
      preHandler: [verifyApiScope("deliveries:write")],
      config: {
        rateLimit: false,
        // Documentation only; see integration-write-documentation.
        openapi: {
          body: integrationWriteSchemas.createDelivery,
          headers: integrationWriteSchemas.idempotencyHeaders,
        },
      },
      schema: {
        security: [{ apiKey: [] }],
        tags: ["integration"],
        operationId: "createDelivery",
        // The hook above enforces it; this only publishes it.
        "x-scopes": ["deliveries:write"],
        summary: "Criar uma entrega",
        description: [
          "Escopo exigido: `deliveries:write` (que não dá leitura). Uma entrega por requisição: a v1 não tem criação em lote — para várias, uma chamada por documento, cada uma com a sua Idempotency-Key.",
          "",
          "As regras são as do cadastro manual no painel, com as mesmas mensagens: destinatário e endereço obrigatórios, CEP com 8 dígitos, data prevista como dia (`AAAA-MM-DD`, sem hora), até 200 itens. O embarcador vem por `shipper_id` ou por `shipper_cnpj` (um dos dois) e precisa ser da sua empresa e estar ativo. Motorista e rota não vêm aqui: a entrega nasce Pendente e é atribuída no painel.",
          "",
          "`Idempotency-Key` é obrigatória. Repetir a mesma chave com o mesmo corpo devolve 200 com a entrega já criada, sem duplicar nem avisar de novo; com outro corpo, 409 IDEMPOTENCY_KEY_REUSED. A chave da NF-e também não se repete: uma nota já cadastrada na empresa responde 409 DELIVERY_INVOICE_KEY_EXISTS com o `delivery_id` dela.",
          "",
          "Assinantes de `delivery.created` recebem o webhook desta entrega, como no cadastro manual. As chamadas contam no mesmo limite por minuto da chave e da empresa que as leituras.",
          "",
          CREATE_DELIVERY_REQUEST_EXAMPLE,
        ].join("\n"),
        response: {
          201: integrationWriteResponses.created,
          200: integrationWriteResponses.replayed,
          400: integrationWriteResponses.badRequest,
          404: integrationWriteResponses.notFound,
          409: integrationWriteResponses.conflict,
          429: integrationWriteResponses.tooManyRequests,
          500: integrationWriteResponses.internalError,
          503: integrationWriteResponses.unavailable,
        },
      },
    },
    createDeliveryController.handle,
  );
}

export { integrationRoutes };

import { FastifyInstance } from "fastify";

import { CreateQuoteController } from "@/modules/quote/usecases/create-quote/create-quote-controller";
import { ListQuotesController } from "@/modules/quote/usecases/list-quotes/list-quotes-controller";

import { UpdateQuoteStatusController } from "@/modules/quote/usecases/update-quote-status/update-quote-status-controller";
import { DeleteQuoteController } from "@/modules/quote/usecases/delete-quote/delete-quote-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";
import {
  quoteSchemas,
  quoteResponses,
} from "./documentation/quote-documentation";
import { ndjsonList, offsetMetaWith } from "./documentation/ndjson";
import { errorResponse } from "./documentation/common-responses";

const createQuoteController = new CreateQuoteController();
const listQuotesController = new ListQuotesController();

const updateQuoteStatusController = new UpdateQuoteStatusController();
const deleteQuoteController = new DeleteQuoteController();

async function quoteRoutes(app: FastifyInstance) {
  app.post(
    "/create-quote",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 20 }),
      },
      schema: {
        tags: ["quote"],
        summary: "Envia um pedido de orçamento (site)",
        description:
          "Pedido de orçamento do site, com os dados da empresa e o tamanho da frota. " +
          "Envie o token do Cloudflare Turnstile em `turnstileToken`: com o segredo configurado, a API confere o token (400 TURNSTILE_FAILED) e, com a exigência ligada, recusa o pedido sem ele (400 TURNSTILE_REQUIRED). " +
          "O e-mail de confirmação não repete nada do que a pessoa digitou e sai no máximo uma vez por dia para cada endereço.",
        body: quoteSchemas.createQuote,
        response: {
          200: quoteResponses.quoteCreated,
          400: quoteResponses.validationError,
          429: quoteResponses.rateLimitExceeded,
          500: quoteResponses.internalServerError,
          503: errorResponse.describe(
            "Não foi possível verificar o Turnstile (TURNSTILE_UNAVAILABLE).",
          ),
        },
      },
    },
    createQuoteController.handle,
  );

  app.get(
    "/list-quote",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["quote"],
        summary: "Lista os pedidos de orçamento (tabela do /admin)",
        description:
          "Pedidos de orçamento do site numa tabela paginada, só para o MASTER. Ordena no servidor (`sort`/`order`) e filtra por estágio (`status`) e tamanho da frota (`fleet_size`) — um ou mais valores separados por vírgula —, além da busca livre (ID, nome, empresa, e-mail, frota, mensagem, anotações e os dígitos do telefone). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões por estágio e as opções dos filtros com as contagens — sobre todos os pedidos, nunca sobre a página.",
        querystring: quoteSchemas.listQuotes,
        response: {
          200: ndjsonList(
            quoteResponses.quoteRow,
            offsetMetaWith(quoteResponses.quoteListSearchMeta),
          ),
          400: quoteResponses.listQuoteErrors,
          403: quoteResponses.listQuoteForbiddenErrors,
          404: quoteResponses.listQuoteNotFoundErrors,
          500: quoteResponses.internalServerError,
        },
      },
    },
    listQuotesController.handle,
  );

  app.patch(
    "/update-quote-status/:quoteId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["quote"],
        summary: "Muda o estágio de um pedido de orçamento",
        description:
          "Atualiza o estágio e as anotações internas de um pedido, só para o MASTER. Pedido inexistente: 404 QUOTE_NOT_FOUND. Pedido já fechado ou convertido não muda mais: 409 QUOTE_ALREADY_FINALIZED.",
        params: quoteSchemas.quoteIdParam,
        body: quoteSchemas.updateQuoteStatus,
        response: {
          200: quoteResponses.quoteStatusUpdated,
          400: quoteResponses.updateQuoteStatusErrors,
          403: quoteResponses.updateQuoteStatusForbiddenErrors,
          404: quoteResponses.updateQuoteStatusNotFoundErrors,
          409: errorResponse.describe(
            "Pedido já fechado ou convertido (QUOTE_ALREADY_FINALIZED).",
          ),
          500: quoteResponses.internalServerError,
        },
      },
    },
    updateQuoteStatusController.handle,
  );

  app.delete(
    "/delete-quote/:quoteId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["quote"],
        summary: "Exclui um pedido de orçamento",
        description:
          "Remove de vez um pedido de orçamento, só para o MASTER. Pedido inexistente: 404 QUOTE_NOT_FOUND.",
        params: quoteSchemas.quoteIdParam,
        response: {
          200: quoteResponses.quoteDeleted,
          400: quoteResponses.deleteQuoteErrors,
          403: quoteResponses.deleteQuoteForbiddenErrors,
          404: quoteResponses.deleteQuoteNotFoundErrors,
          500: quoteResponses.internalServerError,
        },
      },
    },
    deleteQuoteController.handle,
  );
}

export { quoteRoutes };

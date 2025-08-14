import { FastifyInstance } from "fastify";
import { z } from "zod";

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
        summary: "Create a new quote request",
        description: "Submit a new quote request from potential customers with company information and fleet size details",
        body: quoteSchemas.createQuote,
        response: {
          200: quoteResponses.quoteCreated,
          400: quoteResponses.validationError,
          429: quoteResponses.rateLimitExceeded,
          500: quoteResponses.internalServerError,
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
        summary: "List quote requests",
        description: "Retrieve a paginated list of customer quote requests with status filtering and search capabilities",
        querystring: quoteSchemas.listQuotes,
        response: {
          200: quoteResponses.quotesList,
          400: quoteResponses.resourceNotFound,
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
        summary: "Update quote status",
        description: "Update the status and internal notes of a customer quote request for sales pipeline management",
        params: quoteSchemas.quoteIdParam,
        body: quoteSchemas.updateQuoteStatus,
        response: {
          200: quoteResponses.quoteStatusUpdated,
          400: z.union([
            quoteResponses.quoteNotFound,
            quoteResponses.validationError,
          ]),
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
        summary: "Delete a quote request",
        description: "Permanently remove a customer quote request from the system",
        params: quoteSchemas.quoteIdParam,
        response: {
          200: quoteResponses.quoteDeleted,
          400: quoteResponses.quoteNotFound,
          500: quoteResponses.internalServerError,
        },
      },
    },
    deleteQuoteController.handle,
  );
}

export { quoteRoutes };

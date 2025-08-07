import { FastifyInstance } from "fastify";

import { CreateQuoteController } from "@/modules/quote/usecases/create-quote/create-quote-controller";
import { ListQuotesController } from "@/modules/quote/usecases/list-quotes/list-quotes-controller";

import { UpdateQuoteStatusController } from "@/modules/quote/usecases/update-quote-status/update-quote-status-controller";
import { DeleteQuoteController } from "@/modules/quote/usecases/delete-quote/delete-quote-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";

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
    },
    createQuoteController.handle,
  );

  app.get(
    "/list-quote",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
    },
    listQuotesController.handle,
  );

  app.patch(
    "/update-quote-status/:quoteId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
    },
    updateQuoteStatusController.handle,
  );

  app.delete(
    "/delete-quote/:quoteId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
    },
    deleteQuoteController.handle,
  );
}

export { quoteRoutes };

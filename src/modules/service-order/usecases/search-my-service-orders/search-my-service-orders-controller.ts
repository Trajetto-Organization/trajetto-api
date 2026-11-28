import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { SearchMyServiceOrdersUseCase } from "./search-my-service-orders-usecase";
import { myServiceOrdersQuerySchema } from "@/schemas/my-service-orders-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchMyServiceOrdersController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    // Validated AND transformed by the route (limit is a number now):
    // parsing it again against the wire schema would refuse it.
    const { scope, limit, cursor } = request.query as z.infer<
      typeof myServiceOrdersQuerySchema
    >;

    const searchMyServiceOrdersUseCase = container.resolve(
      SearchMyServiceOrdersUseCase,
    );

    const dataPromise = searchMyServiceOrdersUseCase.execute({
      userId: id,
      scope,
      limit,
      cursor,
    });

    // `return await`: the stream opens only after the data resolved, so a
    // refusal (an AppError) still reaches the error handler with its code.
    return await sendAsNDJSON({
      reply,
      dataPromise: dataPromise.then((result) => ({
        data: result.data,
        total: 0,
        meta: {
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        },
      })),
    });
  }
}

export { SearchMyServiceOrdersController };

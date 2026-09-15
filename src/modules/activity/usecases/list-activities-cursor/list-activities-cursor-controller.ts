import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListActivitiesCursorUseCase } from "./list-activities-cursor-usecase";
import { listActivitiesCursorSchema } from "@/schemas/list-activities-cursor-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListActivitiesCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;

      // Parsed here, not by the route schema: the route documents the wire
      // format and this is where the values become numbers and enums.
      const { limit, cursor, search, period, businessId } =
        listActivitiesCursorSchema.parse(request.query);

      const listActivitiesCursorUseCase = container.resolve(
        ListActivitiesCursorUseCase,
      );

      const dataPromise = listActivitiesCursorUseCase.execute({
        userId: id,
        limit,
        cursor,
        search,
        periodDays: period === "30d" ? 30 : 7,
        businessId,
      });

      /**
       * `return await`, not `return`.
       *
       * A bare `return promise` inside a try/catch is not caught: an async
       * function awaits the returned promise AFTER leaving the block, so its
       * rejection walks past every `catch` below and lands in Fastify's
       * generic handler as a 500. Every branch underneath was unreachable —
       * a cross-tenant read answered "Internal server error" instead of 403,
       * and it was logged at error level, which is where real 500s go to
       * hide.
       */
      return await sendAsNDJSON({
        reply,
        dataPromise: dataPromise.then((result) => ({
          data: result.data,
          meta: {
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
            periodDays: period === "30d" ? 30 : 7,
          },
        })),
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListActivitiesCursorController };

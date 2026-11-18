import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListActivitiesCursorUseCase } from "./list-activities-cursor-usecase";
import { listActivitiesCursorSchema } from "@/schemas/list-activities-cursor-schema";

import { sendAsNDJSON } from "@/config/stream-utils";
import { ACTIVITY_DATA_VERSION_HEADER } from "@/shared/activity/activity-data-version";

class ListActivitiesCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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

    // `return await`: the stream opens only after the data resolved, so a
    // refusal (an AppError) still reaches the error handler with its code.
    return await sendAsNDJSON({
      reply,
      dataPromise: dataPromise.then((result) => {
        // Which generation of ids the page is in (plano-escala F2-18): the
        // web drops the feed it holds when this changes.
        reply.header(ACTIVITY_DATA_VERSION_HEADER, result.dataVersion);

        return {
          data: result.data,
          meta: {
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
            periodDays: period === "30d" ? 30 : 7,
          },
        };
      }),
    });
  }
}

export { ListActivitiesCursorController };

import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListUserNotificationsCursorUseCase } from "./list-user-notifications-cursor-usecase";
import { listUserNotificationsCursorSchema } from "@/schemas/list-user-notification-cursor-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListUserNotificationsCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;
      const { limit, includeRead, cursor } =
        listUserNotificationsCursorSchema.parse(request.query);

      const listUserNotificationsCursorUseCase = container.resolve(
        ListUserNotificationsCursorUseCase,
      );

      const dataPromise = listUserNotificationsCursorUseCase.execute({
        userId: id,
        limit,
        includeRead,
        cursor,
      });

      return sendAsNDJSON({
        reply,
        dataPromise: dataPromise.then((result) => ({
          data: result.data,
          total: result.total,
          meta: {
            unread: result.unread,
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
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

export { ListUserNotificationsCursorController };

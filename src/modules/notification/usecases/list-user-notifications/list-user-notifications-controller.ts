import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListUserNotificationsUseCase } from "./list-user-notifications-usecase";

import { listUserNotificationsSchema } from "@/schemas/list-user-notification-schema";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class ListUserNotificationsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    try {
      const { id } = request.user;
      const { limit, includeRead } = listUserNotificationsSchema.parse(
        request.query,
      );

      const listUserNotificationsUseCase = container.resolve(
        ListUserNotificationsUseCase,
      );

      const result = await listUserNotificationsUseCase.execute({
        userId: id,
        limit,
        includeRead,
      });

      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListUserNotificationsController };

import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListPermissionsByProfileUseCase } from "./list-permissions-by-profile-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteProfileAccessSchema } from "@/schemas/update-delete-profile-access-schema";

class ListPermissionsByProfileController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { profileAccessId } = updateDeleteProfileAccessSchema.parse(
      request.params,
    );
    const { businessId } = updateDeleteBusinessSchema.parse(request.query);

    const listPermissionsByProfileUseCase = container.resolve(
      ListPermissionsByProfileUseCase,
    );

    try {
      const permissions = await listPermissionsByProfileUseCase.execute(
        profileAccessId,
        businessId,
        id,
      );

      return reply.status(200).send({ permissions });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListPermissionsByProfileController };

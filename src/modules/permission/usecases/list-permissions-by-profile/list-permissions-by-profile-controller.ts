import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListPermissionsByProfileUseCase } from "./list-permissions-by-profile-usecase";

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

    const permissions = await listPermissionsByProfileUseCase.execute(
      profileAccessId,
      businessId,
      id,
    );

    return reply.status(200).send({ permissions });
  }
}

export { ListPermissionsByProfileController };
